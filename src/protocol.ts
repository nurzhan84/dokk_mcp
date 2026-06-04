// Shared collaboration protocol — message types exchanged over the WebSocket.
//
// MIRROR of `server/collab/src/protocol.ts` and `src/collab/protocol.ts`.
// Keep all three in sync; if you add a message type, change all three.
// Runtime-free types only (no node deps).

export const PROTOCOL_VERSION = 1;

/** Server-stamped monotonically-increasing op sequence number. */
export type Seq = number;

export type PeerId = string;
export type OpId = string;

/** Minimal shape of a hierarchy item — server doesn't read these, it just
 *  relays the whole tree to peers. Kept structurally compatible with the
 *  SPA's HierarchyItem so JSON-roundtrips are lossless. */
export type HierarchyItem = {
  id: string;
  kind: 'document' | 'chapter' | 'board';
  title: string;
  children?: HierarchyItem[];
};

export type PeerInfo = {
  peerId: PeerId;
  name: string;
  /** Hex color used for cursors / selections / avatar background. */
  color: string;
  isOwner: boolean;
  isAgent: boolean;
};

// ---------------------------------------------------------------------------
// Element ops — the payload mirrors the SPA's `BoardElement` shape, but kept
// loose here (Record<string, unknown>) so the server doesn't have to import
// the full client type. The server treats element bodies as opaque blobs.
// ---------------------------------------------------------------------------

export type AddElementOp = {
  kind: 'addElement';
  element: { id: string } & Record<string, unknown>;
};

export type UpdateElementOp = {
  kind: 'updateElement';
  id: string;
  updates: Record<string, unknown>;
};

export type RemoveElementOp = {
  kind: 'removeElement';
  id: string;
};

export type ArrangeOp = {
  kind: 'arrange';
  ids: string[];
  direction: 'up' | 'down' | 'front' | 'back';
};

export type ElementOp = AddElementOp | UpdateElementOp | RemoveElementOp | ArrangeOp;

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

export type ClientHello = {
  type: 'hello';
  protocol: typeof PROTOCOL_VERSION;
  boardId: string;
  name: string;
  /** Required for guests; ignored for owner. */
  inviteToken?: string;
  /** Set true when the client is an AI agent driven by `controlledBy`. */
  isAgent?: boolean;
  controlledBy?: string;
  /** Validation-only handshake. Server runs all the invite checks but does
   *  not register a peer, claim the invite, or broadcast peerJoin. It
   *  replies with `inviteOk` (or an error) and the client closes the
   *  socket. Used before asking the guest to enter their display name. */
  probe?: boolean;
};

export type ClientOp = {
  type: 'op';
  opId: OpId;
  op: ElementOp;
  /** Set true when the op is part of an initial-state publish (host seeding
   *  the server with GitHub-loaded content). Server skips boardActivity for
   *  such ops so peers on other boards don't see a phantom dirty indicator. */
  silent?: boolean;
};

export type ClientCursor = {
  type: 'cursor';
  /** World coords (board space). null = cursor left the canvas. */
  x: number | null;
  y: number | null;
};

export type ClientSelection = {
  type: 'selection';
  ids: string[];
};

export type ClientInviteCreate = {
  type: 'inviteCreate';
  /** Optional human-readable label, e.g. agent name. */
  label?: string;
  /**
   * Optional set of boardIds the invite grants access to. Defaults to just
   * the session's own boardId. Use for chapter / document sharing.
   */
  allowedBoardIds?: string[];
};

export type ClientKick = {
  type: 'kick';
  peerId: PeerId;
};

/**
 * Host-initiated full-hierarchy push. Includes the updated boardId scope for
 * the named token so the server can grant late-arriving guests access to
 * boards that were added after the original invite was created.
 */
export type ClientHierarchyReplace = {
  type: 'hierarchyReplace';
  token: string;
  items: HierarchyItem[];
  allowedBoardIds: string[];
};

/**
 * Host signals that a board was successfully saved to GitHub. The server
 * relays this to in-scope peers so they can clear the dirty indicator for
 * that board.
 */
export type ClientBoardSaved = {
  type: 'boardSaved';
  token: string;
  boardId: string;
};

/** Save a history checkpoint. The server snapshots its current elements
 *  and broadcasts to all peers so their local undo stacks stay in sync. */
export type ClientHistoryPush = {
  type: 'historyPush';
  opId: OpId;
};

/** Pop a history checkpoint. Server pops its undoStack, moves the
 *  pre-undo state to redoStack, and broadcasts the new state so every
 *  peer applies it. */
export type ClientHistoryUndo = {
  type: 'historyUndo';
  opId: OpId;
};

export type ClientHistoryRedo = {
  type: 'historyRedo';
  opId: OpId;
};

export type ClientPing = {
  type: 'ping';
  t: number;
};

export type ClientBye = {
  type: 'bye';
};

/**
 * Guest-initiated request for a host-only operation. Only the host has GitHub
 * write access and broadcasts hierarchyReplace, so a guest agent that wants
 * to e.g. create a new board has to ask the host to do it. Server routes
 * this to the owner peer of the matching invite and relays the host's reply
 * back to the requester (via `hierarchyRequestResult`).
 */
export type ClientHierarchyRequest = {
  type: 'hierarchyRequest';
  /** Correlates the host's reply back to this request. */
  reqId: string;
  action: 'createBoard';
  title: string;
  /** Insert under this chapter; omit to insert at the document root. */
  parentChapterId?: string;
};

export type ClientHierarchyRequestResult = {
  type: 'hierarchyRequestResult';
  reqId: string;
  /** The peer that originally sent the request — the host echoes this back
   *  so the server knows where to route the reply. */
  toPeerId: PeerId;
  ok: boolean;
  /** Present when ok === true and the request created a board. */
  boardId?: string;
  /** Human-readable failure reason. */
  error?: string;
};

export type ClientMessage =
  | ClientHello
  | ClientOp
  | ClientCursor
  | ClientSelection
  | ClientInviteCreate
  | ClientKick
  | ClientHierarchyReplace
  | ClientBoardSaved
  | ClientHistoryPush
  | ClientHistoryUndo
  | ClientHistoryRedo
  | ClientHierarchyRequest
  | ClientHierarchyRequestResult
  | ClientPing
  | ClientBye;

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

export type ServerWelcome = {
  type: 'welcome';
  protocol: typeof PROTOCOL_VERSION;
  peerId: PeerId;
  isOwner: boolean;
  peers: PeerInfo[];
  /** Full board snapshot at this seq. */
  snapshot: { id: string; [k: string]: unknown }[];
  seq: Seq;
  /**
   * For guests: the full scope of boardIds their invite covers. Used by the
   * SPA to decide which boards offer collab vs. read-only. Undefined for
   * hosts.
   */
  allowedBoardIds?: string[];
  /** True when the guest connected with a valid invite but this board is
   *  outside the invite's scope. They can observe in realtime but cannot
   *  send ops. */
  readOnly?: boolean;
  /** Latest hierarchy the host pushed for this invite. Lets a joining
   *  guest replace the stale GitHub-loaded tree with the host's current
   *  (possibly unsaved) one. */
  hierarchyItems?: HierarchyItem[];
};

export type ServerPeerJoin = {
  type: 'peerJoin';
  peer: PeerInfo;
};

export type ServerPeerLeave = {
  type: 'peerLeave';
  peerId: PeerId;
  /** 'left' | 'kicked' | 'timeout' */
  reason: 'left' | 'kicked' | 'timeout';
};

export type ServerOp = {
  type: 'op';
  fromPeerId: PeerId;
  opId: OpId;
  op: ElementOp;
  seq: Seq;
};

export type ServerCursor = {
  type: 'cursor';
  fromPeerId: PeerId;
  x: number | null;
  y: number | null;
};

export type ServerSelection = {
  type: 'selection';
  fromPeerId: PeerId;
  ids: string[];
};

export type ServerInviteCreated = {
  type: 'inviteCreated';
  token: string;
  /** Optional — server can populate if it knows the public origin; otherwise client builds the URL. */
  url?: string;
  expiresAt: number;
};

export type ServerError = {
  type: 'error';
  /**
   * Stable error codes — clients pattern-match on these for UX strings.
   * Add new codes here as features land.
   */
  code:
    | 'invalid_invite'
    | 'invite_expired'
    | 'permission_denied'
    | 'rate_limited'
    | 'bad_message'
    | 'protocol_mismatch'
    | 'host_offline'
    | 'session_ended'
    | 'kicked'
    | 'internal';
  message: string;
};

export type ServerPong = {
  type: 'pong';
  t: number;
};

/**
 * Cross-session notification — sent to the owner of a session that
 * subscribed (via inviteCreate's allowedBoardIds) when an op runs in
 * a different board's session.
 */
export type ServerBoardActivity = {
  type: 'boardActivity';
  boardId: string;
};

/** Relayed hierarchy update — guests apply this to their sidebar so new
 *  boards/chapters appear (and removed ones disappear) in real time. */
export type ServerHierarchyReplace = {
  type: 'hierarchyReplace';
  fromPeerId: PeerId;
  items: HierarchyItem[];
};

/** Relayed save notification — guests clear the dirty indicator for the
 *  named board because the host pushed it to GitHub. */
export type ServerBoardSaved = {
  type: 'boardSaved';
  boardId: string;
};

/** Reply to a probe `hello` (where `probe: true`). Token is valid; the
 *  client may now ask the user for a name and reconnect with a real hello. */
export type ServerInviteOk = {
  type: 'inviteOk';
};

/** History push applied — server captured a snapshot of the session
 *  state. All peers should mirror this on their local undoStack so the
 *  history depth stays consistent. */
export type ServerHistoryPushApplied = {
  type: 'historyPushApplied';
  fromPeerId: PeerId;
  opId: OpId;
  snapshot: ({ id: string } & Record<string, unknown>)[];
};

/** Undo applied — server popped its undoStack, server.elements is now
 *  this snapshot. All peers should adopt these elements wholesale and
 *  pop their local undoStack to stay in sync. */
export type ServerHistoryUndoApplied = {
  type: 'historyUndoApplied';
  fromPeerId: PeerId;
  opId: OpId;
  snapshot: ({ id: string } & Record<string, unknown>)[];
};

export type ServerHistoryRedoApplied = {
  type: 'historyRedoApplied';
  fromPeerId: PeerId;
  opId: OpId;
  snapshot: ({ id: string } & Record<string, unknown>)[];
};

/** Relayed to the host: a guest is asking it to perform a hierarchy action
 *  (e.g. create a board). The host applies it via its own store actions
 *  and replies with `hierarchyRequestResult`. */
export type ServerHierarchyRequest = {
  type: 'hierarchyRequest';
  fromPeerId: PeerId;
  reqId: string;
  action: 'createBoard';
  title: string;
  parentChapterId?: string;
};

/** Relayed back to the original requester with the outcome. */
export type ServerHierarchyRequestResult = {
  type: 'hierarchyRequestResult';
  reqId: string;
  ok: boolean;
  boardId?: string;
  error?: string;
};

export type ServerMessage =
  | ServerWelcome
  | ServerPeerJoin
  | ServerPeerLeave
  | ServerOp
  | ServerCursor
  | ServerSelection
  | ServerInviteCreated
  | ServerError
  | ServerPong
  | ServerBoardActivity
  | ServerHierarchyReplace
  | ServerBoardSaved
  | ServerInviteOk
  | ServerHistoryPushApplied
  | ServerHistoryUndoApplied
  | ServerHistoryRedoApplied
  | ServerHierarchyRequest
  | ServerHierarchyRequestResult;
