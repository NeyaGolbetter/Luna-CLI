import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LunaError } from '../utils/errors.js';
import { log } from '../utils/logger.js';
import { VERSION } from '../utils/formatter.js';
import {
  loadMcpConfig,
  serverEndpoint,
  serverTransport,
  type McpConfigFile,
  type McpServerEntry,
} from '../utils/mcp-config.js';
import type { ToolDefinition } from '../providers/types.js';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerHandle {
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  endpoint: string;
  client: Client;
  tools: McpTool[];
}

export interface McpServerStatus {
  name: string;
  transport: string;
  endpoint: string;
  ok: boolean;
  toolCount: number;
  error?: string;
}

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;

function fetchWithHeaders(headers: Record<string, string>): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return (input, init) =>
    fetch(input, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), ...headers },
    });
}

/** OpenAI function names must match ^[a-zA-Z0-9_-]{1,64}$ */
export function sanitizeFunctionName(name: string): string {
  let out = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (out.length > 64) out = out.slice(0, 63) + '_';
  return out || 'tool';
}

/**
 * Manages every configured MCP server (stdio + SSE + streamable HTTP):
 * connection lifecycle, tool discovery, OpenAI tool-schema translation and
 * intercepted tool execution (Module B).
 */
export class McpManager {
  private handles: McpServerHandle[] = [];
  /** display name (what the LLM sees) -> original tool name + handle */
  private index = new Map<string, { handle: McpServerHandle; tool: string }>();
  private statusList: McpServerStatus[] = [];

  get servers(): readonly McpServerHandle[] {
    return this.handles;
  }

  /** Connect to all configured servers. Failures are isolated and reported. */
  async connectAll(cfg: McpConfigFile = loadMcpConfig()): Promise<McpServerHandle[]> {
    this.statusList = [];
    this.handles = [];
    this.index.clear();

    const names = Object.keys(cfg.mcpServers);
    for (const name of names) {
      const entry = cfg.mcpServers[name];
      const t0 = Date.now();
      let client: Client | null = null;
      let t: ReturnType<McpManager['buildTransport']> | null = null;
      try {
        const transport = serverTransport(entry);
        client = new Client({ name: 'luna-cli', version: VERSION });
        t = this.buildTransport(name, entry, transport);
        const connectP = client.connect(t);
        connectP.catch(() => undefined); // race loser must not become an unhandled rejection
        let connectTimer: NodeJS.Timeout | undefined;
        const timeoutP = new Promise<never>((_, reject) => {
          connectTimer = setTimeout(
            () => reject(new LunaError(`timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)),
            CONNECT_TIMEOUT_MS,
          );
        });
        try {
          await Promise.race([connectP, timeoutP]);
        } finally {
          clearTimeout(connectTimer); // keep the timer from holding the event loop
        }
        const listed = await client.listTools();
        const tools: McpTool[] = (listed.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        }));
        const handle: McpServerHandle = {
          name,
          transport,
          endpoint: serverEndpoint(entry),
          client,
          tools,
        };
        this.handles.push(handle);
        for (const tool of tools) this.registerDisplayTool(handle, tool.name);
        this.statusList.push({
          name,
          transport,
          endpoint: handle.endpoint,
          ok: true,
          toolCount: tools.length,
        });
        log.debug(`mcp ${name} (${transport}) ready in ${Date.now() - t0}ms with ${tools.length} tools`);
      } catch (e) {
        // Always tear the transport down on failure — a dead child otherwise
        // leaves stdio pipes in the event loop and the process will not exit.
        if (t) {
          try {
            await t.close();
          } catch {
            /* ignore */
          }
        }
        if (client) {
          try {
            await client.close();
          } catch {
            /* ignore */
          }
        }
        const msg = e instanceof Error ? e.message : String(e);
        log.debug(`mcp ${name} failed: ${msg}`);
        this.statusList.push({
          name,
          transport: serverTransport(entry),
          endpoint: serverEndpoint(entry),
          ok: false,
          toolCount: 0,
          error: msg,
        });
      }
    }
    return this.handles;
  }

  private buildTransport(name: string, entry: McpServerEntry, transport: string) {
    if (transport === 'stdio') {
      const stdio = entry as { command: string; args?: string[]; env?: Record<string, string> };
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      if (stdio.env) Object.assign(env, stdio.env);
      return new StdioClientTransport({
        command: stdio.command,
        args: stdio.args ?? [],
        env,
        stderr: 'ignore',
      });
    }
    const remote = entry as { url: string; headers?: Record<string, string> };
    const url = new URL(remote.url);
    const headers = remote.headers ?? {};
    if (transport === 'http') {
      return new StreamableHTTPClientTransport(url, { requestInit: headers ? { headers } : undefined });
    }
    return new SSEClientTransport(url, {
      // The eventsource package has no `headers` option — inject them via a
      // wrapped fetch instead.
      eventSourceInit: Object.keys(headers).length
        ? { fetch: fetchWithHeaders(headers) as never }
        : undefined,
      requestInit: Object.keys(headers).length ? { headers } : undefined,
    });
  }

  /**
   * Register a tool under an OpenAI-safe display name. Collisions across
   * servers are disambiguated with a `server__` prefix.
   */
  private registerDisplayTool(handle: McpServerHandle, tool: string): string {
    const base = sanitizeFunctionName(tool);
    let display = base;
    const taken = this.index.get(display);
    if (taken && (taken.handle.name !== handle.name || taken.tool !== tool)) {
      display = sanitizeFunctionName(`${handle.name}__${tool}`);
    }
    this.index.set(display, { handle, tool });
    return display;
  }

  /** Translate all connected MCP tools to OpenAI function-calling schemas. */
  toolDefs(): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const [display, { handle, tool }] of this.index) {
      const t = handle.tools.find((x) => x.name === tool);
      if (!t) continue;
      const desc = t.description ? `${t.description} [server: ${handle.name}]` : `[server: ${handle.name}]`;
      out.push({
        type: 'function',
        function: {
          name: display,
          description: desc,
          parameters: t.inputSchema && Object.keys(t.inputSchema).length > 0 ? t.inputSchema : { type: 'object', properties: {} },
        },
      });
    }
    return out;
  }

  toolCount(): number {
    return this.index.size;
  }

  resolve(displayName: string): { handle: McpServerHandle; tool: string } | null {
    return this.index.get(displayName) ?? null;
  }

  /**
   * Execute a tool by display name. Returns the textual result.
   * Throws LunaError when the tool reports an error (text is preserved so the
   * LLM can react to it).
   */
  async callTool(displayName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const entry = this.index.get(displayName);
    if (!entry) {
      throw new LunaError(`Unknown tool "${displayName}". Known tools: ${[...this.index.keys()].join(', ') || '(none)'}`);
    }
    const { handle, tool } = entry;
    const res = (await handle.client.callTool(
      { name: tool, arguments: args },
      undefined,
      { timeout: CALL_TIMEOUT_MS, signal },
    )) as {
      content?: Array<{ type: string; text?: string; data?: string; uri?: string; mimeType?: string }>;
      isError?: boolean;
      structuredContent?: unknown;
    };

    const parts: string[] = [];
    for (const block of res.content ?? []) {
      if (block.type === 'text' && block.text) parts.push(block.text);
      else if (block.type === 'image') parts.push(`[image ${block.mimeType ?? ''}]`);
      else if (block.type === 'resource') parts.push(`[resource ${block.uri ?? 'inline'}]`);
    }
    if (parts.length === 0 && res.structuredContent !== undefined) {
      parts.push(JSON.stringify(res.structuredContent));
    }
    const text = parts.join('\n') || '(no output)';
    if (res.isError) {
      throw new LunaError(`Tool "${displayName}" (server ${handle.name}) returned an error:\n${text}`);
    }
    return text;
  }

  statuses(): McpServerStatus[] {
    return this.statusList;
  }

  /** Clean shutdown of every transport (no lingering children or sockets). */
  async disconnectAll(): Promise<void> {
    await Promise.all(
      this.handles.map(async (h) => {
        try {
          await h.client.close();
        } catch {
          /* already closed */
        }
      }),
    );
    this.handles = [];
    this.index.clear();
  }
}
