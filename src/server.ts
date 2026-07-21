// Transport-agnostic factory: build an MCP server pre-wired with all Dokk
// tools and a fresh DokkAgent. Both stdio and HTTP entry points call this.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DokkAgent } from './core/dokk-agent.js';
import { registerTools } from './tools.js';

export type BuildOptions = {
  /** Optional pre-built agent (handy for tests that share state across
   *  transports). Otherwise a fresh DokkAgent is created. */
  agent?: DokkAgent;
};

export function buildServer(opts: BuildOptions = {}): {
  server: McpServer;
  agent: DokkAgent;
} {
  const agent = opts.agent ?? new DokkAgent();
  const server = new McpServer({
    name: 'dokk-mcp',
    version: '0.0.1',
  });
  registerTools(server, agent);
  return { server, agent };
}
