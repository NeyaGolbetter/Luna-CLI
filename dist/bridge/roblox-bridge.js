import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ExecutorNotAttachedError } from '../utils/errors.js';
import { log } from '../utils/logger.js';
import { VERSION } from '../utils/formatter.js';
import { registerRobloxTools } from './roblox-tools.js';
const POLLING_WINDOW_MS = 5_000;
const MAX_SCRIPT_BYTES = 1_000_000;
/**
 * Luna Roblox Bridge (Module C.1/C.2).
 *
 * A local HTTP + WebSocket server that sits between Luna (local or remote
 * through a Cloudflare Tunnel) and a Roblox executor:
 *
 *   GET  /status            attachment + backend info
 *   POST /execute           {script} → forwarded to the executor
 *   GET  /execute/poll      Luau polling clients fetch their next job
 *   POST /execute/result    Luau polling clients post job results
 *   WS   /ws                WebSocket sidecar on the game machine
 *   GET  /sse               MCP (SSE) endpoint: run_luau_script, get_game_state
 *   POST /message           MCP (SSE) client messages
 */
export async function startBridge(opts = {}) {
    const host = opts.host ?? '127.0.0.1';
    const port = opts.port ?? Number(process.env.LUNA_BRIDGE_PORT) ?? 8172;
    const executorUrl = opts.executorUrl ?? process.env.LUNA_EXECUTOR_URL ?? null;
    const executeTimeoutMs = opts.executeTimeoutMs ?? 60_000;
    const startedAt = Date.now();
    let companionWs = null;
    const pendingWsResults = new Map();
    const jobQueue = new Map();
    /** Jobs picked up by a poller, awaiting its result. */
    const activeJobs = new Map();
    let lastPollAt = 0;
    let everPolled = false;
    let jobCounter = 0;
    const sseSessions = new Map();
    let closed = false;
    function describe() {
        if (companionWs && companionWs.readyState === WebSocket.OPEN) {
            return { attached: true, backend: 'ws-companion', detail: 'WebSocket sidecar connected' };
        }
        if (executorUrl) {
            return { attached: true, backend: 'http', detail: `direct HTTP → ${executorUrl}` };
        }
        if (Date.now() - lastPollAt < POLLING_WINDOW_MS) {
            return { attached: true, backend: 'polling', detail: 'Luau polling script active' };
        }
        return {
            attached: false,
            backend: 'none',
            detail: 'no executor attached — load the polling script in an executor, run the WS sidecar, or set --executor-url',
        };
    }
    function statusInfo() {
        const d = describe();
        return { ...d, version: VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000) };
    }
    async function executeViaWs(script, timeoutMs) {
        if (!companionWs || companionWs.readyState !== WebSocket.OPEN) {
            throw new ExecutorNotAttachedError('WS companion disconnected.');
        }
        const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingWsResults.delete(id);
                reject(new ExecutorNotAttachedError(`WS companion timed out after ${timeoutMs / 1000}s`));
            }, timeoutMs);
            pendingWsResults.set(id, { resolve, reject, timer });
            companionWs.send(JSON.stringify({ id, type: 'execute', script }));
        });
    }
    async function executeViaHttp(script, timeoutMs) {
        const url = executorUrl;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ script }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new ExecutorNotAttachedError(`executor HTTP responded ${res.status}: ${body.slice(0, 200)}`);
        }
        return (await res.text()).slice(0, MAX_SCRIPT_BYTES) || '(no output)';
    }
    function executeViaPolling(script, timeoutMs) {
        const id = `job-${++jobCounter}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                jobQueue.delete(id);
                activeJobs.delete(id);
                reject(new ExecutorNotAttachedError(`executor (polling) did not respond within ${timeoutMs / 1000}s`));
            }, timeoutMs);
            // Fast-fail with the friendly "nothing attached" error when no polling
            // client has ever shown up (avoids waiting the full timeout).
            let noPollerTimer;
            if (!everPolled) {
                noPollerTimer = setTimeout(() => {
                    if (!jobQueue.has(id))
                        return;
                    jobQueue.delete(id);
                    clearTimeout(timer);
                    reject(new ExecutorNotAttachedError('no executor attached — load the polling script in an executor, run the WS sidecar, or set --executor-url'));
                }, Math.min(timeoutMs, 3000));
            }
            jobQueue.set(id, { id, script, resolve, reject, timer, noPollerTimer });
        });
    }
    const executeScript = async (script, timeoutMs = executeTimeoutMs) => {
        if (typeof script !== 'string' || script.trim().length === 0) {
            throw new ExecutorNotAttachedError('empty script');
        }
        const d = describe();
        if (d.backend === 'ws-companion')
            return executeViaWs(script, timeoutMs);
        if (d.backend === 'http')
            return executeViaHttp(script, timeoutMs);
        // No WS sidecar / direct HTTP: queue for a polling client. If none
        // appears quickly, the promise rejects with a friendly error.
        return executeViaPolling(script, timeoutMs);
    };
    const executorAdapter = {
        execute: executeScript,
        describe,
    };
    /* ---------------- HTTP server ---------------- */
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
            const method = req.method ?? 'GET';
            if (method === 'GET' && url.pathname === '/') {
                return json(res, 200, {
                    name: 'luna-roblox-bridge',
                    version: VERSION,
                    endpoints: ['/status', '/execute', '/execute/poll', '/execute/result', '/ws', '/sse'],
                });
            }
            if (method === 'GET' && url.pathname === '/status') {
                return json(res, 200, statusInfo());
            }
            if (method === 'POST' && url.pathname === '/execute') {
                const body = await readJsonBody(req);
                const script = body?.script;
                const timeout = typeof body?.timeout === 'number' ? Math.min(Math.max(body.timeout, 1000), 300_000) : executeTimeoutMs;
                if (typeof script !== 'string' || script.length === 0) {
                    return json(res, 400, { ok: false, error: 'body must be JSON {"script": "…"}' });
                }
                try {
                    const data = await executeScript(script, timeout);
                    return json(res, 200, { ok: true, data });
                }
                catch (e) {
                    const notAttached = e instanceof ExecutorNotAttachedError;
                    return json(res, notAttached ? 502 : 504, { ok: false, error: e instanceof Error ? e.message : String(e) });
                }
            }
            if (method === 'GET' && url.pathname === '/execute/poll') {
                lastPollAt = Date.now();
                everPolled = true;
                const next = jobQueue.values().next();
                if (!next.done) {
                    const job = next.value;
                    jobQueue.delete(job.id);
                    if (job.noPollerTimer)
                        clearTimeout(job.noPollerTimer);
                    activeJobs.set(job.id, job);
                    return json(res, 200, { id: job.id, script: job.script });
                }
                res.writeHead(204).end();
                return;
            }
            if (method === 'POST' && url.pathname === '/execute/result') {
                const body = await readJsonBody(req);
                const id = typeof body?.id === 'string' ? body.id : '';
                const job = activeJobs.get(id);
                if (!job)
                    return json(res, 404, { ok: false, error: `unknown job ${id}` });
                activeJobs.delete(id);
                clearTimeout(job.timer);
                if (body?.ok) {
                    job.resolve(typeof body.data === 'string' ? body.data : body.data === undefined ? '(no output)' : JSON.stringify(body.data));
                }
                else {
                    job.reject(new ExecutorNotAttachedError(`executor error: ${body?.error ?? 'unknown'}`));
                }
                return json(res, 200, { ok: true });
            }
            if (method === 'GET' && url.pathname === '/sse') {
                return handleMcpSse(url, res);
            }
            if (method === 'POST' && url.pathname === '/message') {
                const sessionId = url.searchParams.get('sessionId') ?? '';
                const session = sseSessions.get(sessionId);
                if (!session) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'unknown or expired MCP session' }));
                    return;
                }
                await session.handlePostMessage(req, res);
                return;
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
        }
        catch (e) {
            log.debug(`bridge request error: ${e instanceof Error ? e.message : String(e)}`);
            if (!res.headersSent)
                res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'internal bridge error' }));
        }
    });
    function handleMcpSse(url, res) {
        // One McpServer per SSE session (the SDK server binds to a single transport).
        const mcp = new McpServer({ name: 'luna-roblox-bridge', version: VERSION });
        registerRobloxTools(mcp, executorAdapter);
        const transport = new SSEServerTransport('/message', res);
        sseSessions.set(transport.sessionId, transport);
        transport.onclose = () => {
            sseSessions.delete(transport.sessionId);
            log.debug('mcp sse session closed');
        };
        void mcp.connect(transport).catch((e) => {
            log.debug(`mcp connect error: ${e instanceof Error ? e.message : String(e)}`);
            if (!res.headersSent)
                res.writeHead(500);
            res.end();
        });
    }
    /* ---------------- WebSocket sidecar (game machine) ---------------- */
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (ws) => {
        if (companionWs && companionWs.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', error: 'another companion is already connected' }));
            ws.close(1000, 'replaced');
            return;
        }
        companionWs = ws;
        log.info(`  companion connected (${ws.remoteAddress ?? '?'})`);
        ws.send(JSON.stringify({ type: 'welcome', version: VERSION, name: 'luna-roblox-bridge' }));
        ws.on('message', (data) => {
            let msg;
            try {
                msg = JSON.parse(String(data));
            }
            catch {
                return;
            }
            if (msg.type === 'result' && typeof msg.id === 'string') {
                const pending = pendingWsResults.get(msg.id);
                if (!pending)
                    return;
                pendingWsResults.delete(msg.id);
                clearTimeout(pending.timer);
                if (msg.ok) {
                    pending.resolve(msg.data === undefined ? '(no output)' : typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data));
                }
                else {
                    pending.reject(new ExecutorNotAttachedError(`executor error: ${msg.error ?? 'unknown'}`));
                }
            }
        });
        const detach = () => {
            if (companionWs === ws) {
                companionWs = null;
                log.info('  companion disconnected');
            }
            for (const [, p] of pendingWsResults) {
                clearTimeout(p.timer);
                p.reject(new ExecutorNotAttachedError('companion disconnected'));
            }
            pendingWsResults.clear();
        };
        ws.on('close', detach);
        ws.on('error', detach);
    });
    /* ---------------- lifecycle ---------------- */
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
    });
    const actualPort = server.address().port;
    const bridge = {
        server,
        host,
        port: actualPort,
        statusInfo,
        executeScript,
        close: async () => {
            if (closed)
                return;
            closed = true;
            for (const [, p] of pendingWsResults) {
                clearTimeout(p.timer);
                p.reject(new ExecutorNotAttachedError('bridge shutting down'));
            }
            pendingWsResults.clear();
            for (const [, job] of jobQueue) {
                clearTimeout(job.timer);
                if (job.noPollerTimer)
                    clearTimeout(job.noPollerTimer);
                job.reject(new ExecutorNotAttachedError('bridge shutting down'));
            }
            for (const [, job] of activeJobs) {
                clearTimeout(job.timer);
                job.reject(new ExecutorNotAttachedError('bridge shutting down'));
            }
            jobQueue.clear();
            activeJobs.clear();
            for (const s of sseSessions.values()) {
                try {
                    await s.close();
                }
                catch {
                    /* ignore */
                }
            }
            sseSessions.clear();
            for (const c of wss.clients)
                c.terminate();
            try {
                companionWs?.close();
            }
            catch {
                /* ignore */
            }
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
    return bridge;
}
function json(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}
async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_SCRIPT_BYTES + 65_536) {
            throw new Error('payload too large');
        }
        chunks.push(chunk);
    }
    if (chunks.length === 0)
        return null;
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    }
    catch {
        return null;
    }
}
/* ---------------- standalone entrypoint (luna bridge start) ---------------- */
async function main() {
    const argv = process.argv.slice(2);
    const get = (flag) => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const port = get('--port') ? Number(get('--port')) : Number(process.env.LUNA_BRIDGE_PORT) || 8172;
    const host = get('--host') ?? '127.0.0.1';
    const executorUrl = get('--executor-url');
    const bridge = await startBridge({ port, host, executorUrl });
    log.info(`luna-roblox-bridge v${VERSION} listening on http://${host}:${bridge.port}`);
    log.info(`  status  GET  http://${host}:${bridge.port}/status`);
    log.info(`  exec    POST http://${host}:${bridge.port}/execute`);
    log.info(`  mcp     GET  http://${host}:${bridge.port}/sse`);
    log.info('press Ctrl+C to stop');
    const shutdown = async () => {
        log.info('shutting down…');
        await bridge.close().catch(() => undefined);
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
}
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
    main().catch((e) => {
        log.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
    });
}
