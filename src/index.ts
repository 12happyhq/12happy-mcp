#!/usr/bin/env node
/**
 * 12happy MCP server: uptime monitoring for AI assistants, over stdio.
 *
 *   TWELVEHAPPY_API_KEY   required, a key from the API keys page of the 12happy console
 *   TWELVEHAPPY_ORG       optional, the organization to act on (default: the key's own)
 *   TWELVEHAPPY_API_URL   optional, defaults to https://be.12hpy.com/v1
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_BASE_URL, TwelveHappyClient, VERSION } from './client.js';
import { registerTools } from './tools.js';

const apiKey = process.env.TWELVEHAPPY_API_KEY?.trim();
if (!apiKey) {
  console.error(
    '12happy-mcp: set TWELVEHAPPY_API_KEY to a key from the API keys page of the 12happy console (app.12hpy.com). ' +
      'API access is included on the Pro and Agency plans.',
  );
  process.exit(1);
}

const server = new McpServer(
  { name: '12happy', title: '12happy uptime monitoring', version: VERSION, websiteUrl: 'https://www.12hpy.com/' },
  {
    instructions:
      '12happy checks websites, APIs, servers, DNS and SSL certificates from several regions and opens an incident only when ' +
      'a quorum of regions agrees. Use get_overview for "is anything down?", list_monitors to find ids, get_monitor to explain ' +
      'a failure, and get_uptime_report for SLA and speed questions. Before deleting a monitor, confirm with the user; pausing ' +
      'keeps its history.',
  },
);

registerTools(
  server,
  new TwelveHappyClient(apiKey, process.env.TWELVEHAPPY_API_URL || DEFAULT_BASE_URL),
  process.env.TWELVEHAPPY_ORG?.trim() || 'me',
);

await server.connect(new StdioServerTransport());
