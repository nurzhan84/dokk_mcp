// Transport-agnostic factory: build an MCP server pre-wired with all Doka
// tools and a fresh DokaAgent. Both stdio and HTTP entry points call this.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DokaAgent } from './core/doka-agent.js';
import { registerTools } from './tools.js';

export type BuildOptions = {
  /** Optional pre-built agent (handy for tests that share state across
   *  transports). Otherwise a fresh DokaAgent is created. */
  agent?: DokaAgent;
};

export function buildServer(opts: BuildOptions = {}): {
  server: McpServer;
  agent: DokaAgent;
} {
  const agent = opts.agent ?? new DokaAgent();
  const server = new McpServer({
    name: 'doka-mcp',
    version: '0.0.1',
  });
  registerTools(server, agent);
  return { server, agent };
}
