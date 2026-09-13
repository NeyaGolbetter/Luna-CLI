import { mcpConfigPath, readJsonFile, writeJsonAtomic } from './paths.js';
import { LunaError } from './errors.js';

export type McpTransport = 'stdio' | 'sse' | 'http';

export interface McpStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  url?: never;
  transport?: 'stdio';
}

export interface McpRemoteServer {
  url: string;
  transport?: 'sse' | 'http';
  headers?: Record<string, string>;
  command?: never;
}

export type McpServerEntry = McpStdioServer | McpRemoteServer;

export interface McpConfigFile {
  mcpServers: Record<string, McpServerEntry>;
}

export function sanitizeServerName(name: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new LunaError(`Invalid server name "${name}" — use 1-64 chars of [a-zA-Z0-9_-].`);
  }
  return name;
}

/** Infer the transport from an entry: command → stdio, url → sse (default) or http. */
export function serverTransport(entry: McpServerEntry): McpTransport {
  if (entry && typeof entry.command === 'string') return 'stdio';
  if (entry && typeof entry.url === 'string') return entry.transport === 'http' ? 'http' : 'sse';
  throw new LunaError('MCP server entry must define either "command" (stdio) or "url" (sse/http).');
}

export function serverEndpoint(entry: McpServerEntry): string {
  if (entry && typeof entry.url === 'string') return entry.url;
  if (entry && typeof entry.command === 'string') {
    const args = entry.args ?? [];
    return [entry.command, ...args].join(' ');
  }
  return '?';
}

export function loadMcpConfig(): McpConfigFile {
  const raw = readJsonFile<unknown>(mcpConfigPath());
  if (!raw || typeof raw !== 'object') return { mcpServers: {} };
  const servers = (raw as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== 'object') {
    throw new LunaError(`Invalid ${mcpConfigPath()}: missing "mcpServers" object.`);
  }
  const out: Record<string, McpServerEntry> = {};
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') {
      throw new LunaError(`Invalid MCP server "${name}" in ${mcpConfigPath()}.`);
    }
    out[name] = entry as McpServerEntry;
  }
  return { mcpServers: out };
}

export function saveMcpConfig(cfg: McpConfigFile): void {
  writeJsonAtomic(mcpConfigPath(), cfg);
}

export function addMcpServer(name: string, entry: McpServerEntry): McpConfigFile {
  sanitizeServerName(name);
  const cfg = loadMcpConfig();
  cfg.mcpServers[name] = entry;
  saveMcpConfig(cfg);
  return cfg;
}

export function removeMcpServer(name: string): McpConfigFile {
  const cfg = loadMcpConfig();
  if (!(name in cfg.mcpServers)) {
    throw new LunaError(`No MCP server named "${name}" (see \`luna mcp list\`).`);
  }
  delete cfg.mcpServers[name];
  saveMcpConfig(cfg);
  return cfg;
}

export function mcpConfigFile(): string {
  return mcpConfigPath();
}
