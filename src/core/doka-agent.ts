// DokaAgent — programmatic collab client used by the MCP tool layer.
//
// Maintains one WebSocket session for the agent (per active board), mirrors
// the server snapshot in memory so tools can read elements without an extra
// round-trip, and exposes async methods that map 1:1 to the collab protocol
// ops (addElement/updateElement/…/cursor/selection/hierarchyRequest).
//
// Switching boards is handled by `switchBoard`, which tears down the current
// socket and opens a new one with the same invite token — the same flow a
// human guest takes when they click a different board in the sidebar.

import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ElementOp,
  type HierarchyItem,
  type PeerInfo,
  type ServerMessage,
} from '../protocol.js';

export type ConnectOptions = {
  /** Base WebSocket URL of the collab server, e.g. `ws://localhost:8787`. */
  collabUrl: string;
  boardId: string;
  inviteToken: string;
  /** Display name shown to other peers in the room. */
  name?: string;
  /** Sent in the hello so the host UI can see who's driving the agent. */
  controlledBy?: string;
};

export type ConnectResult = {
  peerId: string;
  isOwner: boolean;
  boardId: string;
  /** Initial elements at welcome time. */
  snapshot: BoardElementLike[];
  peers: PeerInfo[];
  allowedBoardIds?: string[];
  /** True when this board is outside the invite's scope — agent can observe
   *  but the server will reject any ops it sends. */
  readOnly: boolean;
  hierarchyItems?: HierarchyItem[];
};

/** Loose element type — the agent treats elements as opaque records with an
 *  id, matching how the collab server stores them. Schema validation lives
 *  in the MCP tool layer. */
export type BoardElementLike = { id: string } & Record<string, unknown>;

/** Reasons we treat the socket as terminal — no point reconnecting on these. */
const TERMINAL_ERROR_CODES = new Set([
  'invalid_invite',
  'invite_expired',
  'protocol_mismatch',
  'session_ended',
  'kicked',
]);

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class DokaAgent {
  /** Open WebSocket; null while disconnected. */
  private ws: WebSocket | null = null;
  /** Mirror of session.elements, kept up to date by incoming ops. */
  private elements: BoardElementLike[] = [];
  /** Live peer roster from welcome + peerJoin/peerLeave deltas. */
  private peers = new Map<string, PeerInfo>();
  /** My own peerId, set by welcome. */
  private peerId: string | null = null;
  private isOwner = false;
  private readOnly = false;
  private currentBoardId: string | null = null;
  private currentOpts: ConnectOptions | null = null;
  /** In-flight hierarchy requests keyed by reqId. Resolved by matching
   *  server replies; rejected on socket close. */
  private pendingHierarchyReqs = new Map<
    string,
    { resolve: (r: { ok: boolean; boardId?: string; error?: string }) => void }
  >();

  // -- public surface ------------------------------------------------------

  /** Open a new collab session. Rejects if the server denies the hello. */
  async connect(opts: ConnectOptions): Promise<ConnectResult> {
    if (this.ws) {
      throw new Error('already connected — call disconnect() first');
    }
    this.currentOpts = opts;
    return this.openSocket(opts);
  }

  /** Close the current session cleanly. Idempotent. */
  async disconnect(): Promise<void> {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    try { ws.send(JSON.stringify({ type: 'bye' } satisfies ClientMessage)); } catch { /* */ }
    try { ws.close(); } catch { /* */ }
    this.resetSessionState();
  }

  /** Disconnect from the current board and re-open a session on `boardId`,
   *  reusing the same invite token. Mirrors how a human guest navigates
   *  between boards within a shared scope. */
  async switchBoard(boardId: string): Promise<ConnectResult> {
    const opts = this.currentOpts;
    if (!opts) throw new Error('not connected — call connect() first');
    await this.disconnect();
    const nextOpts: ConnectOptions = { ...opts, boardId };
    this.currentOpts = nextOpts;
    return this.openSocket(nextOpts);
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getBoardId(): string | null {
    return this.currentBoardId;
  }

  getPeerId(): string | null {
    return this.peerId;
  }

  listElements(): BoardElementLike[] {
    // Shallow copy so callers can't mutate the mirror.
    return this.elements.map((el) => ({ ...el }));
  }

  getElement(id: string): BoardElementLike | null {
    const el = this.elements.find((e) => e.id === id);
    return el ? { ...el } : null;
  }

  listPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  /** Add a new element. Server-generated id is not used — the caller passes
   *  one in `element.id` (the MCP tool layer mints uuids). */
  async addElement(element: BoardElementLike): Promise<string> {
    this.assertWritable();
    if (!element.id || typeof element.id !== 'string') {
      throw new Error('element.id required');
    }
    if (this.elements.some((e) => e.id === element.id)) {
      throw new Error(`element ${element.id} already exists`);
    }
    // Optimistic local apply so a subsequent list_elements call (within the
    // same tool turn) sees it before the server echo arrives.
    this.elements.push({ ...element });
    this.sendOp({ kind: 'addElement', element });
    return element.id;
  }

  async updateElement(id: string, patch: Record<string, unknown>): Promise<void> {
    this.assertWritable();
    const idx = this.elements.findIndex((e) => e.id === id);
    if (idx === -1) throw new Error(`element ${id} not found`);
    this.elements[idx] = { ...this.elements[idx], ...patch };
    this.sendOp({ kind: 'updateElement', id, updates: patch });
  }

  async removeElement(id: string): Promise<void> {
    this.assertWritable();
    const idx = this.elements.findIndex((e) => e.id === id);
    if (idx === -1) throw new Error(`element ${id} not found`);
    this.elements.splice(idx, 1);
    this.sendOp({ kind: 'removeElement', id });
  }

  async arrange(ids: string[], direction: 'up' | 'down' | 'front' | 'back'): Promise<void> {
    this.assertWritable();
    if (ids.length === 0) return;
    this.applyArrangeLocal(ids, direction);
    this.sendOp({ kind: 'arrange', ids, direction });
  }

  /** Pure mirror mutation — used by both outbound arrange and incoming op
   *  echoes so the local snapshot matches what the server now holds. */
  private applyArrangeLocal(ids: string[], direction: 'up' | 'down' | 'front' | 'back'): void {
    const idSet = new Set(ids);
    if (direction === 'front') {
      const sel = this.elements.filter((e) => idSet.has(e.id));
      const rest = this.elements.filter((e) => !idSet.has(e.id));
      this.elements = [...rest, ...sel];
      return;
    }
    if (direction === 'back') {
      const sel = this.elements.filter((e) => idSet.has(e.id));
      const rest = this.elements.filter((e) => !idSet.has(e.id));
      this.elements = [...sel, ...rest];
      return;
    }
    if (direction === 'up') {
      for (let i = this.elements.length - 2; i >= 0; i -= 1) {
        if (!idSet.has(this.elements[i].id) || idSet.has(this.elements[i + 1].id)) continue;
        const next = this.elements[i];
        this.elements[i] = this.elements[i + 1];
        this.elements[i + 1] = next;
      }
      return;
    }
    for (let i = 1; i < this.elements.length; i += 1) {
      if (!idSet.has(this.elements[i].id) || idSet.has(this.elements[i - 1].id)) continue;
      const prev = this.elements[i];
      this.elements[i] = this.elements[i - 1];
      this.elements[i - 1] = prev;
    }
  }

  moveCursor(x: number | null, y: number | null): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send({ type: 'cursor', x, y });
  }

  setSelection(ids: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send({ type: 'selection', ids });
  }

  /** Ask the host to create a new board in the document hierarchy. Resolves
   *  with the new boardId on success; rejects on host error / disconnect. */
  async createBoard(opts: {
    title: string;
    parentChapterId?: string;
    timeoutMs?: number;
  }): Promise<string> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('not connected');
    }
    const reqId = randomUUID();
    const reply = new Promise<{ ok: boolean; boardId?: string; error?: string }>((resolve) => {
      this.pendingHierarchyReqs.set(reqId, { resolve });
    });
    this.send({
      type: 'hierarchyRequest',
      reqId,
      action: 'createBoard',
      title: opts.title,
      parentChapterId: opts.parentChapterId,
    });
    const timeout = new Promise<{ ok: false; error: string }>((resolve) => {
      const t = setTimeout(() => {
        this.pendingHierarchyReqs.delete(reqId);
        resolve({ ok: false, error: 'host did not respond in time' });
      }, opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      // Don't keep the event loop alive purely for this timer.
      (t as { unref?: () => void }).unref?.();
    });
    const result = await Promise.race([reply, timeout]);
    if (!result.ok || !result.boardId) {
      throw new Error(result.error ?? 'createBoard failed');
    }
    return result.boardId;
  }

  // -- internals -----------------------------------------------------------

  private assertWritable(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('not connected');
    }
    if (this.readOnly) {
      throw new Error('current board is outside the invite scope (read-only)');
    }
  }

  private send(msg: ClientMessage): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  private sendOp(op: ElementOp): void {
    this.send({ type: 'op', opId: randomUUID(), op });
  }

  private resetSessionState(): void {
    this.elements = [];
    this.peers.clear();
    this.peerId = null;
    this.isOwner = false;
    this.readOnly = false;
    this.currentBoardId = null;
    // Reject any in-flight hierarchy requests so callers don't hang.
    for (const { resolve } of this.pendingHierarchyReqs.values()) {
      resolve({ ok: false, error: 'disconnected' });
    }
    this.pendingHierarchyReqs.clear();
  }

  /** Open WS, await welcome, return the resolved handshake. Throws on any
   *  failure (network, server error, terminal close before welcome). */
  private openSocket(opts: ConnectOptions): Promise<ConnectResult> {
    const url = `${opts.collabUrl.replace(/\/+$/, '')}/board/${encodeURIComponent(opts.boardId)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.currentBoardId = opts.boardId;
    return new Promise<ConnectResult>((resolve, reject) => {
      let settled = false;
      const settleErr = (err: Error) => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* */ }
        this.ws = null;
        this.resetSessionState();
        reject(err);
      };
      ws.on('open', () => {
        const hello: ClientMessage = {
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          boardId: opts.boardId,
          name: opts.name?.trim() || 'AI Agent',
          inviteToken: opts.inviteToken,
          isAgent: true,
          controlledBy: opts.controlledBy,
        };
        try { ws.send(JSON.stringify(hello)); } catch (err) {
          settleErr(err instanceof Error ? err : new Error('hello send failed'));
        }
      });
      ws.on('message', (data) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(data.toString()) as ServerMessage;
        } catch {
          return;
        }
        if (!settled && msg.type === 'welcome') {
          settled = true;
          this.peerId = msg.peerId;
          this.isOwner = msg.isOwner;
          this.readOnly = msg.readOnly === true;
          this.elements = msg.snapshot.map((el) => ({ ...el }));
          this.peers.clear();
          for (const p of msg.peers) this.peers.set(p.peerId, p);
          resolve({
            peerId: msg.peerId,
            isOwner: msg.isOwner,
            boardId: opts.boardId,
            snapshot: this.listElements(),
            peers: this.listPeers(),
            allowedBoardIds: msg.allowedBoardIds,
            readOnly: this.readOnly,
            hierarchyItems: msg.hierarchyItems,
          });
          return;
        }
        if (!settled && msg.type === 'error') {
          settleErr(new Error(`${msg.code}: ${msg.message}`));
          return;
        }
        this.handleServerMessage(msg);
      });
      ws.on('close', () => {
        const wasSettled = settled;
        // Only tear down session state if this is still the live socket.
        // A close event from a previous socket (e.g. after switchBoard())
        // would otherwise clobber the freshly-opened one.
        if (this.ws === ws) {
          this.ws = null;
          this.resetSessionState();
        }
        if (!wasSettled) {
          settleErr(new Error('connection closed before welcome'));
        }
      });
      ws.on('error', (err) => {
        if (!settled) settleErr(err instanceof Error ? err : new Error('socket error'));
      });
    });
  }

  /** Apply a post-welcome message to the local mirror. */
  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'op': {
        // Echo of our own op or another peer's — either way, re-apply against
        // the mirror so it converges to server state. (Our own optimistic
        // apply may already match; redundant apply is harmless because the
        // server's snapshot is authoritative.)
        const op = msg.op;
        switch (op.kind) {
          case 'addElement': {
            if (!this.elements.some((e) => e.id === op.element.id)) {
              this.elements.push({ ...op.element });
            }
            return;
          }
          case 'updateElement': {
            const idx = this.elements.findIndex((e) => e.id === op.id);
            if (idx !== -1) {
              this.elements[idx] = { ...this.elements[idx], ...op.updates };
            }
            return;
          }
          case 'removeElement': {
            const idx = this.elements.findIndex((e) => e.id === op.id);
            if (idx !== -1) this.elements.splice(idx, 1);
            return;
          }
          case 'arrange': {
            // Mirror the server's reorder locally — do NOT re-broadcast.
            this.applyArrangeLocal(op.ids, op.direction);
            return;
          }
        }
        return;
      }
      case 'peerJoin':
        this.peers.set(msg.peer.peerId, msg.peer);
        return;
      case 'peerLeave':
        this.peers.delete(msg.peerId);
        return;
      case 'historyPushApplied':
      case 'historyUndoApplied':
      case 'historyRedoApplied': {
        // Server delivered an authoritative snapshot — adopt wholesale.
        this.elements = msg.snapshot.map((el) => ({ ...el }));
        return;
      }
      case 'hierarchyRequestResult': {
        const pending = this.pendingHierarchyReqs.get(msg.reqId);
        if (pending) {
          this.pendingHierarchyReqs.delete(msg.reqId);
          pending.resolve({ ok: msg.ok, boardId: msg.boardId, error: msg.error });
        }
        return;
      }
      case 'error': {
        // Non-terminal errors (rate_limited, bad_message, permission_denied,
        // host_offline) are surfaced to whoever called the most recent tool
        // by failing in-flight requests. Terminal errors close the socket.
        if (TERMINAL_ERROR_CODES.has(msg.code)) {
          try { this.ws?.close(); } catch { /* */ }
        }
        return;
      }
      default:
        return;
    }
  }
}
