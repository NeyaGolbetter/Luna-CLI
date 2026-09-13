import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LunaError } from '../utils/errors.js';
import { log } from '../utils/logger.js';
import { VERSION } from '../utils/formatter.js';
import { loadMcpConfig, serverEndpoint, serverTransport, } from '../utils/mcp-config.js';
const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
function fetchWithHeaders(headers) {
    return (input, init) => fetch(input, {
        ...init,
        headers: { ...init?.headers, ...headers },
    });
}
/** OpenAI function names must match ^[a-zA-Z0-9_-]{1,64}$ */
export function sanitizeFunctionName(name) {
    let out = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (out.length > 64)
        out = out.slice(0, 63) + '_';
    return out || 'tool';
}
/**
 * Manages every configured MCP server (stdio + SSE + streamable HTTP):
 * connection lifecycle, tool discovery, OpenAI tool-schema translation and
 * intercepted tool execution (Module B).
 */
export class McpManager {
    handles = [];
    /** display name (what the LLM sees) -> original tool name + handle */
    index = new Map();
    statusList = [];
    get servers() {
        return this.handles;
    }
    /** Connect to all configured servers. Failures are isolated and reported. */
    async connectAll(cfg = loadMcpConfig()) {
        this.statusList = [];
        this.handles = [];
        this.index.clear();
        const names = Object.keys(cfg.mcpServers);
        for (const name of names) {
            const entry = cfg.mcpServers[name];
            const t0 = Date.now();
            let client = null;
            let t = null;
            try {
                const transport = serverTransport(entry);
                client = new Client({ name: 'luna-cli', version: VERSION });
                t = this.buildTransport(name, entry, transport);
                const connectP = client.connect(t);
                connectP.catch(() => undefined); // race loser must not become an unhandled rejection
                let connectTimer;
                const timeoutP = new Promise((_, reject) => {
                    connectTimer = setTimeout(() => reject(new LunaError(`timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS);
                });
                try {
                    await Promise.race([connectP, timeoutP]);
                }
                finally {
                    clearTimeout(connectTimer); // keep the timer from holding the event loop
                }
                const listed = await client.listTools();
                const tools = (listed.tools ?? []).map((t) => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
                }));
                const handle = {
                    name,
                    transport,
                    endpoint: serverEndpoint(entry),
                    client,
                    tools,
                };
                this.handles.push(handle);
                for (const tool of tools)
                    this.registerDisplayTool(handle, tool.name);
                this.statusList.push({
                    name,
                    transport,
                    endpoint: handle.endpoint,
                    ok: true,
                    toolCount: tools.length,
                });
                log.debug(`mcp ${name} (${transport}) ready in ${Date.now() - t0}ms with ${tools.length} tools`);
            }
            catch (e) {
                // Always tear the transport down on failure — a dead child otherwise
                // leaves stdio pipes in the event loop and the process will not exit.
                if (t) {
                    try {
                        await t.close();
                    }
                    catch {
                        /* ignore */
                    }
                }
                if (client) {
                    try {
                        await client.close();
                    }
                    catch {
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
    buildTransport(name, entry, transport) {
        if (transport === 'stdio') {
            const stdio = entry;
            const env = {};
            for (const [k, v] of Object.entries(process.env))
                if (v !== undefined)
                    env[k] = v;
            if (stdio.env)
                Object.assign(env, stdio.env);
            return new StdioClientTransport({
                command: stdio.command,
                args: stdio.args ?? [],
                env,
                stderr: 'ignore',
            });
        }
        const remote = entry;
        const url = new URL(remote.url);
        const headers = remote.headers ?? {};
        if (transport === 'http') {
            return new StreamableHTTPClientTransport(url, { requestInit: headers ? { headers } : undefined });
        }
        return new SSEClientTransport(url, {
            // The eventsource package has no `headers` option — inject them via a
            // wrapped fetch instead.
            eventSourceInit: Object.keys(headers).length
                ? { fetch: fetchWithHeaders(headers) }
                : undefined,
            requestInit: Object.keys(headers).length ? { headers } : undefined,
        });
    }
    /**
     * Register a tool under an OpenAI-safe display name. Collisions across
     * servers are disambiguated with a `server__` prefix.
     */
    registerDisplayTool(handle, tool) {
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
    toolDefs() {
        const out = [];
        for (const [display, { handle, tool }] of this.index) {
            const t = handle.tools.find((x) => x.name === tool);
            if (!t)
                continue;
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
    toolCount() {
        return this.index.size;
    }
    resolve(displayName) {
        return this.index.get(displayName) ?? null;
    }
    /**
     * Execute a tool by display name. Returns the textual result.
     * Throws LunaError when the tool reports an error (text is preserved so the
     * LLM can react to it).
     */
    async callTool(displayName, args, signal) {
        const entry = this.index.get(displayName);
        if (!entry) {
            throw new LunaError(`Unknown tool "${displayName}". Known tools: ${[...this.index.keys()].join(', ') || '(none)'}`);
        }
        const { handle, tool } = entry;
        const res = (await handle.client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS, signal }));
        const parts = [];
        for (const block of res.content ?? []) {
            if (block.type === 'text' && block.text)
                parts.push(block.text);
            else if (block.type === 'image')
                parts.push(`[image ${block.mimeType ?? ''}]`);
            else if (block.type === 'resource')
                parts.push(`[resource ${block.uri ?? 'inline'}]`);
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
    statuses() {
        return this.statusList;
    }
    /** Clean shutdown of every transport (no lingering children or sockets). */
    async disconnectAll() {
        await Promise.all(this.handles.map(async (h) => {
            try {
                await h.client.close();
            }
            catch {
                /* already closed */
            }
        }));
        this.handles = [];
        this.index.clear();
    }
}
