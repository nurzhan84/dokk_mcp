// End-to-end smoke for DokkAgent against a self-contained collab server.
//
// Spins up a Session-backed WebSocket server (mirroring the pattern in
// server/collab/src/agent-smoke-test.ts), runs a stub "host" peer that does
// what the SPA's op-bridge would do (seed an invite + hierarchy, answer
// hierarchyRequest), then drives DokkAgent through:
//
//   connect → add_shape → createBoard → switchBoard → add_shape → disconnect
//
// The host script asserts that the agent's ops landed and that the new
// board surfaced via hierarchyReplace.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { Session, type Transport } from '../../collab/src/session.js';
import { PROTOCOL_VERSION, type ServerMessage } from './protocol.js';
import { DokkAgent } from './core/dokk-agent.js';

const BOARD_ENTRY = 'mcp-smoke-entry';

function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const sessions = new Map<string, Session>();
    const httpServer = createServer((_req, res) => { res.writeHead(404); res.end(); });
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => {
      const match = (req.url ?? '').match(/^\/board\/([^/?#]+)/);
      if (!match) { socket.destroy(); return; }
      const boardId = decodeURIComponent(match[1]);
      wss.handleUpgrade(req, socket, head, (ws) => {
        let session = sessions.get(boardId);
        if (!session) {
          session = new Session(boardId);
          session.setOnRetire(() => sessions.delete(boardId));
          sessions.set(boardId, session);
        }
        let peerId: string | null = null;
        const transport: Transport = {
          send: (raw) => ws.send(raw),
          close: (code, reason) => ws.close(code, reason),
        };
        ws.on('message', (data) => {
          let parsed: unknown;
          try { parsed = JSON.parse(data.toString()); } catch { return; }
          if (peerId === null) {
            const id = session!.acceptHello(transport, parsed);
            if (id) peerId = id; else transport.close(1008, 'rejected');
          } else {
            session!.handleMessage(peerId, parsed);
          }
        });
        ws.on('close', () => { if (peerId) session!.removePeer(peerId, 'left'); });
      });
    });
    httpServer.listen(0, '127.0.0.1', () => {
      const port = (httpServer.address() as { port: number }).port;
      resolve({
        port,
        close: () => new Promise<void>((r) => { wss.close(); httpServer.close(() => r()); }),
      });
    });
  });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
}

async function main(): Promise<void> {
  const { port, close } = await startServer();
  const collabUrl = `ws://127.0.0.1:${port}`;

  // --- Host stub: claim the entry board, mint an invite spanning the
  // initial doc, and respond to any hierarchyRequest like the SPA bridge
  // would — but using simple WebSocket sends to keep this script tiny.
  const docId = randomUUID();
  const hierarchy: { id: string; kind: 'document' | 'board'; title: string; children?: unknown[] }[] = [
    { id: docId, kind: 'document', title: 'Smoke Doc', children: [
      { id: BOARD_ENTRY, kind: 'board', title: 'Entry' },
    ] },
  ];
  function allBoardIdsIn(items: typeof hierarchy): string[] {
    const out: string[] = [];
    const walk = (list: typeof hierarchy) => {
      for (const it of list) {
        if (it.kind === 'board') out.push(it.id);
        if (it.children) walk(it.children as typeof hierarchy);
      }
    };
    walk(items);
    return out;
  }

  const host = new WebSocket(`${collabUrl}/board/${BOARD_ENTRY}`);
  await new Promise<void>((res, rej) => { host.once('open', () => res()); host.once('error', rej); });
  host.send(JSON.stringify({
    type: 'hello', protocol: PROTOCOL_VERSION,
    boardId: BOARD_ENTRY, name: 'Smoke Host',
  }));

  let inviteToken: string | null = null;
  let agentSeen = false;
  const addsByBoard = new Map<string, number>(); // we can't directly know — track via session
  // Track ops received by host's session — every op fans out to all peers,
  // so the host sees its own connected-board ops here.
  const opsOnEntry: { kind: string; elementId?: string }[] = [];
  let createBoardReplied = false;
  let newBoardId: string | null = null;

  host.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as ServerMessage;
    if (msg.type === 'welcome' && !inviteToken) {
      host.send(JSON.stringify({
        type: 'inviteCreate',
        label: 'smoke-agent',
        allowedBoardIds: allBoardIdsIn(hierarchy),
      }));
      return;
    }
    if (msg.type === 'inviteCreated') {
      inviteToken = msg.token;
      // Seed the invite with the host's current hierarchy so the agent's
      // welcome carries it — matches what the SPA Share-dialog code does.
      host.send(JSON.stringify({
        type: 'hierarchyReplace',
        token: inviteToken,
        items: hierarchy,
        allowedBoardIds: allBoardIdsIn(hierarchy),
      }));
      return;
    }
    if (msg.type === 'peerJoin' && msg.peer.isAgent) {
      agentSeen = true;
      return;
    }
    if (msg.type === 'op') {
      opsOnEntry.push({
        kind: msg.op.kind,
        elementId: msg.op.kind === 'addElement'
          ? (msg.op.element.id as string)
          : msg.op.kind === 'updateElement' ? msg.op.id : undefined,
      });
      const ids = addsByBoard.get(BOARD_ENTRY) ?? 0;
      if (msg.op.kind === 'addElement') addsByBoard.set(BOARD_ENTRY, ids + 1);
      return;
    }
    if (msg.type === 'hierarchyRequest') {
      // Simulate the SPA bridge: pick parent, mint id, splice, reply + broadcast.
      assert(msg.action === 'createBoard', 'unexpected hierarchyRequest action');
      newBoardId = randomUUID();
      // Insert under the existing document.
      hierarchy[0].children = [...(hierarchy[0].children ?? []), { id: newBoardId, kind: 'board', title: msg.title }];
      host.send(JSON.stringify({
        type: 'hierarchyRequestResult',
        reqId: msg.reqId,
        toPeerId: msg.fromPeerId,
        ok: true,
        boardId: newBoardId,
      }));
      host.send(JSON.stringify({
        type: 'hierarchyReplace',
        token: inviteToken,
        items: hierarchy,
        allowedBoardIds: allBoardIdsIn(hierarchy),
      }));
      createBoardReplied = true;
      return;
    }
  });

  // Wait for the invite to be minted before the agent connects.
  const inviteDeadline = Date.now() + 3000;
  while (!inviteToken) {
    if (Date.now() > inviteDeadline) throw new Error('invite never minted');
    await new Promise((r) => setTimeout(r, 20));
  }

  // --- Agent flow ---
  const agent = new DokkAgent();
  const welcome = await agent.connect({
    collabUrl,
    boardId: BOARD_ENTRY,
    inviteToken: inviteToken!,
    name: 'Smoke Agent',
    controlledBy: 'mcp-smoke',
  });
  assert(welcome.peerId, 'agent welcome missing peerId');
  assert(welcome.boardId === BOARD_ENTRY, 'wrong boardId in welcome');
  assert(welcome.snapshot.length === 0, 'expected empty initial snapshot');

  // Place a shape on the entry board.
  const entryShapeId = randomUUID();
  await agent.addElement({
    id: entryShapeId,
    type: 'shape',
    shapeType: 'rectangle',
    x: 100, y: 100, width: 80, height: 40,
    color: '#3b82f6',
  });
  // Allow the server echo to round-trip.
  await new Promise((r) => setTimeout(r, 80));

  // Ask the host to create a new board, switching to it.
  const createdId = await agent.createBoard({ title: 'Generated by agent', parentChapterId: docId });
  assert(createdId === newBoardId, 'createBoard returned a different id than the host minted');
  assert(createBoardReplied, 'host never received the hierarchyRequest');

  // Open the new board and place a shape there.
  const second = await agent.switchBoard(createdId);
  assert(second.boardId === createdId, 'switchBoard did not move us to the new board');
  assert(second.snapshot.length === 0, 'new board should be empty');

  const newShapeId = randomUUID();
  await agent.addElement({
    id: newShapeId,
    type: 'shape',
    shapeType: 'circle',
    x: 200, y: 200, width: 60, height: 60,
    color: '#10b981',
  });
  await new Promise((r) => setTimeout(r, 80));

  // Disconnect cleanly.
  await agent.disconnect();
  assert(!agent.isConnected(), 'agent should be disconnected');

  // --- Assertions on host visibility ---
  assert(agentSeen, 'host never saw the agent peerJoin');
  const entryAdds = opsOnEntry.filter((o) => o.kind === 'addElement');
  assert(entryAdds.some((o) => o.elementId === entryShapeId),
    `entry-board addElement op not seen by host (got ${JSON.stringify(entryAdds)})`);

  console.log('\n✅ dokk-mcp smoke OK', {
    agentPeerId: welcome.peerId,
    createdBoardId: createdId,
    entryOps: opsOnEntry.length,
  });

  host.close();
  await new Promise((r) => setTimeout(r, 50));
  await close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
