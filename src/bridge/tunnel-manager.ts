import fs from 'node:fs';
import path from 'node:path';
import { config } from '../utils/config.js';
import { LunaError } from '../utils/errors.js';
import { log } from '../utils/logger.js';
import { bridgeScriptPath, logPath, statePath } from '../utils/paths.js';
import {
  findExecutable,
  isPidAlive,
  killPid,
  readLogTail,
  sleep,
  spawnDetached,
  waitFor,
} from '../utils/process.js';
import { addMcpServer, loadMcpConfig, saveMcpConfig } from '../utils/mcp-config.js';
import { clearBridgeState, writeBridgeState } from '../cli/bridge.js';

export interface TunnelState {
  url: string;
  port: number;
  targetUrl: string;
  cfPid: number;
  bridgePid: number | null;
  bridgeOwned: boolean;
  logFile: string;
  startedAt: string;
}

const TRYCLFLARE_RE = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

export function tunnelStateFile(): string {
  return statePath('tunnel');
}

export function readTunnelState(): TunnelState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(tunnelStateFile(), 'utf8')) as TunnelState;
    if (typeof raw.url === 'string') return raw;
    return null;
  } catch {
    return null;
  }
}

export function tunnelAlive(): boolean {
  const st = readTunnelState();
  return Boolean(st && (isPidAlive(st.cfPid) || isPidAlive(st.bridgePid)));
}

export function findCloudflared(): string | null {
  const found = findExecutable('cloudflared');
  if (found) return found;
  // Common manual install locations.
  const candidates = [
    '/usr/local/bin/cloudflared',
    '/opt/homebrew/bin/cloudflared',
    '/snap/bin/cloudflared',
    path.join(process.env.HOME ?? '', 'bin', 'cloudflared'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

async function waitBridgeReady(port: number, timeoutMs = 15_000): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/status`;
  const ready = await waitFor(
    async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
        return res.ok;
      } catch {
        return false;
      }
    },
    timeoutMs,
    300,
  );
  return Boolean(ready);
}

export interface StartTunnelOptions {
  port: number;
  targetUrl?: string;
  bridge?: boolean;
  executorUrl?: string;
  cloudflared?: string;
  /** Extra cloudflared args (e.g. ['--token', 'abc']). */
  extraArgs?: string[];
  /** Wait up to N ms for the trycloudflare URL. */
  urlTimeoutMs?: number;
  /** Auto-register the tunnel as an SSE MCP server named remote-tunnel. */
  registerMcp?: boolean;
  mcpName?: string;
}

/**
 * `luna tunnel start` (Module C.2):
 *  1. (optional) spawn the local Roblox bridge on `port`
 *  2. spawn `cloudflared tunnel --url http://localhost:port`
 *  3. capture the ephemeral https://*.trycloudflare.com URL from the log
 *  4. persist state + inject into Luna config / MCP configuration
 */
export async function startTunnel(opts: StartTunnelOptions): Promise<TunnelState> {
  if (tunnelAlive()) {
    throw new LunaError('A tunnel is already running — `luna tunnel stop` first (see `luna tunnel status`).');
  }

  const cloudflared = opts.cloudflared ?? findCloudflared();
  if (!cloudflared || !fs.existsSync(cloudflared)) {
    throw new LunaError(
      [
        'cloudflared was not found on PATH.',
        '  • Linux:   sudo apt install cloudflared  (or: snap install cloudflared)',
        '  • macOS:   brew install cloudflared',
        '  • Windows: winget install Cloudflare.cloudflared',
        '  • Termux:  there is no Android build — run the tunnel from a PC and',
        '              point the Roblox bridge at it (`luna mcp add remote-tunnel <pc-tunnel-url> --sse`).',
      ].join('\n'),
    );
  }

  const targetUrl = opts.targetUrl ?? `http://localhost:${opts.port}`;
  const logFile = logPath('tunnel');
  let bridgePid: number | null = null;
  let bridgeOwned = false;
  let cfPid: number | null = null;

  try {
    if (opts.bridge) {
      log.info(`starting local Roblox bridge on port ${opts.port}…`);
      const args = ['--port', String(opts.port), '--host', '127.0.0.1'];
      if (opts.executorUrl) args.push('--executor-url', opts.executorUrl);
      bridgePid = spawnDetached(process.execPath, [bridgeScriptPath(), ...args], logFile);
      const ok = await waitBridgeReady(opts.port);
      if (!ok) throw new LunaError(`bridge did not become ready on port ${opts.port} (check ${logFile})`);
      bridgeOwned = true;
      log.success(`bridge ready (pid ${bridgePid})`);
      writeBridgeState({
        pid: bridgePid,
        port: opts.port,
        host: '127.0.0.1',
        executorUrl: opts.executorUrl ?? null,
        startedAt: new Date().toISOString(),
        logFile,
      });
    }

    const cfArgs = ['tunnel', '--url', targetUrl, '--no-autoupdate', ...(opts.extraArgs ?? [])];
    log.info('starting cloudflared tunnel…');
    cfPid = spawnDetached(cloudflared, cfArgs, logFile);

    const url = await waitFor(
      () => {
        const m = readLogTail(logFile, 40).match(TRYCLFLARE_RE);
        return m ? m[0] : null;
      },
      opts.urlTimeoutMs ?? 90_000,
      500,
    );
    if (!url) {
      const tail = readLogTail(logFile);
      throw new LunaError(
        `cloudflared did not publish a URL in time.\nlog tail:\n${tail || '(empty log)'}`,
      );
    }

    const state: TunnelState = {
      url,
      port: opts.port,
      targetUrl,
      cfPid,
      bridgePid,
      bridgeOwned,
      logFile,
      startedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(tunnelStateFile()), { recursive: true });
    fs.writeFileSync(tunnelStateFile(), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    config.save({
      tunnel: {
        url,
        port: opts.port,
        targetUrl,
        cfPid,
        bridgePid,
        startedAt: state.startedAt,
        logFile,
      },
    });
    if (opts.registerMcp !== false) {
      const name = opts.mcpName ?? 'remote-tunnel';
      addMcpServer(name, { url: `${url}/sse`, transport: 'sse' });
    }
    return state;
  } catch (e) {
    // Roll back everything we started.
    if (cfPid) await killPid(cfPid);
    if (bridgeOwned && bridgePid) await killPid(bridgePid);
    try {
      fs.unlinkSync(tunnelStateFile());
    } catch {
      /* ignore */
    }
    config.save({ tunnel: null });
    throw e;
  }
}

export async function stopTunnel(): Promise<{ stoppedCloudflared: boolean; stoppedBridge: boolean }> {
  const st = readTunnelState();
  if (!st) throw new LunaError('No tunnel is running (see `luna tunnel status`).');
  const cf = isPidAlive(st.cfPid) ? await killPid(st.cfPid) : false;
  const bridge = st.bridgeOwned && st.bridgePid ? await killPid(st.bridgePid) : false;
  if (st.bridgeOwned) clearBridgeState();
  try {
    fs.unlinkSync(tunnelStateFile());
  } catch {
    /* ignore */
  }
  config.save({ tunnel: null });
  // Drop the auto-registered MCP server if it still points at this tunnel.
  try {
    const cfg = loadMcpConfig();
    for (const [name, entry] of Object.entries(cfg.mcpServers)) {
      if ('url' in entry && typeof entry.url === 'string' && entry.url.startsWith(st.url)) {
        delete cfg.mcpServers[name];
        saveMcpConfig(cfg);
        log.debug(`removed stale MCP server "${name}"`);
      }
    }
  } catch (e) {
    log.debug(`could not clean mcp_servers.json: ${e instanceof Error ? e.message : String(e)}`);
  }
  await sleep(100);
  return { stoppedCloudflared: cf, stoppedBridge: bridge };
}

export function tunnelStatus(): {
  running: boolean;
  state: TunnelState | null;
  cfAlive: boolean;
  bridgeAlive: boolean;
  hint: string;
} {
  const st = readTunnelState();
  if (!st) {
    return { running: false, state: null, cfAlive: false, bridgeAlive: false, hint: 'run `luna tunnel start`' };
  }
  const cfAlive = isPidAlive(st.cfPid);
  const bridgeAlive = st.bridgePid ? isPidAlive(st.bridgePid) : false;
  return {
    running: cfAlive || bridgeAlive,
    state: st,
    cfAlive,
    bridgeAlive,
    hint: cfAlive ? 'run `luna tunnel stop` to tear it down' : 'stale state — run `luna tunnel stop` then start again',
  };
}
