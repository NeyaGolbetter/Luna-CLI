#!/usr/bin/env node
/**
 * Minimal MCP stdio server for tests: exposes echo_tool(msg) and
 * boom_tool() which always errors.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fake-server', version: '1.0.0' });

server.tool('echo_tool', 'Echoes the input back', { msg: z.string() }, async ({ msg }) => ({
  content: [{ type: 'text', text: `echo:${msg}` }],
}));

server.tool('boom_tool', 'Always fails', {}, async () => ({
  content: [{ type: 'text', text: 'deliberate failure' }],
  isError: true,
}));

await server.connect(new StdioServerTransport());
