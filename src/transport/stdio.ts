// stdio MCP entry point — spawned per session by Claude Desktop / Code.
//
// stdout is reserved for the MCP framing; *every* log line must go to stderr
// or the client will reject the frame as malformed JSON.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from '../server.js';
import { autoConnectFromEnvIfRequested } from '../tools.js';

async function main(): Promise<void> {
  const { server, agent } = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // DOKK_AUTOCONNECT=1: open the collab session up-front so the agent can go
  // straight to add_*/list_*/etc. without first calling dokk_connect. Errors
  // are logged to stderr but don't abort the process — the agent can still
  // call dokk_connect manually to recover.
  await autoConnectFromEnvIfRequested(agent);
  // Best-effort cleanup when the client closes the pipe so we don't leak the
  // outbound WebSocket connection to the collab server.
  const shutdown = (): void => {
    void agent.disconnect().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdin.once('end', shutdown);
  console.error('[dokk-mcp-stdio] ready');
}

main().catch((err) => {
  console.error('[dokk-mcp-stdio] fatal:', err);
  process.exit(1);
});
