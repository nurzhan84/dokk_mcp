// HTTP MCP entry point — one long-running Node process that any remote MCP
// client can point at. Uses the SDK's StreamableHTTP transport, which speaks
// SSE for server→client streams and POST for client→server requests.
//
// One DokaAgent per HTTP session — stale sessions are GC'd on transport
// close, freeing the outbound WebSocket back to the collab server.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from '../server.js';
import { DokaAgent } from '../core/doka-agent.js';

const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? '0.0.0.0';
const SESSION_HEADER = 'mcp-session-id';

type Session = {
  transport: StreamableHTTPServerTransport;
  agent: DokaAgent;
};
const sessions = new Map<string, Session>();

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    res.writeHead(400).end();
    return;
  }
  // Single MCP endpoint — initialization comes in as a POST with no session
  // header; subsequent POST/GET/DELETE carry the issued session id.
  if (req.url !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  try {
    const sessionId = req.headers[SESSION_HEADER];
    const headerId = Array.isArray(sessionId) ? sessionId[0] : sessionId;
    let existing = headerId ? sessions.get(headerId) : undefined;

    let body: unknown = undefined;
    if (req.method === 'POST') {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : undefined;
    }

    if (!existing) {
      // Only initialization is allowed without a session id.
      if (req.method !== 'POST') {
        res.writeHead(400).end('missing session id');
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          sessions.set(id, { transport, agent });
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && sessions.has(id)) {
          const sess = sessions.get(id)!;
          sessions.delete(id);
          void sess.agent.disconnect().catch(() => { /* */ });
        }
      };
      const { server, agent } = buildServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    await existing.transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('[doka-mcp-http] handler error:', err);
    if (!res.headersSent) res.writeHead(500).end('internal error');
    else res.end();
  }
});

httpServer.listen(PORT, HOST, () => {
  console.error(`[doka-mcp-http] listening on http://${HOST}:${PORT}/mcp`);
});

const shutdown = (): void => {
  console.error('[doka-mcp-http] shutting down');
  httpServer.close();
  for (const { agent } of sessions.values()) {
    void agent.disconnect().catch(() => { /* */ });
  }
  sessions.clear();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
