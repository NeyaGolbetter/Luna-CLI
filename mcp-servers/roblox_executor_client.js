#!/usr/bin/env node
/**
 * Luna Roblox WS sidecar — run this ON THE MACHINE WITH THE GAME CLIENT
 * (Windows/PC side), where the executor exposes a local HTTP listener or
 * where you can otherwise pipe scripts in.
 *
 *   node mcp-servers/roblox_executor_client.js \
 *     --bridge ws://YOUR-PHONE-IP:8172/ws \
 *     --executor-url http://127.0.0.1:8172   # your executor's local HTTP API
 *
 * The sidecar connects out to the bridge's WebSocket, then forwards every
 * script it receives to the executor's local HTTP endpoint and returns the
 * executor's response. Use together with `luna bridge start --host 0.0.0.0`
 * (or a Cloudflare Tunnel) on the Luna side.
 *
 * Env alternatives: LUNA_BRIDGE_WS, LUNA_EXECUTOR_URL.
 */
import { WebSocket } from 'ws';

function argvValue(flag, env) {
  const i = process.argv.indexOf(flag);
  return (i >= 0 && process.argv[i + 1]) || process.env[env] || null;
}

const BRIDGE_WS = argvValue('--bridge', 'LUNA_BRIDGE_WS');
const EXECUTOR_URL = argvValue('--executor-url', 'LUNA_EXECUTOR_URL');

if (!BRIDGE_WS || !EXECUTOR_URL) {
  console.error(
    [
      'usage: node roblox_executor_client.js --bridge ws://host:port/ws --executor-url http://127.0.0.1:PORT',
      '',
      '  --bridge          the Luna bridge WebSocket endpoint (LUNA_BRIDGE_WS)',
      '  --executor-url    the executor\'s local HTTP API (LUNA_EXECUTOR_URL)',
    ].join('\n'),
  );
  process.exit(1);
}

let delay = 1000;
let stopping = false;

async function forward(script) {
  const res = await fetch(EXECUTOR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`executor HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

function connect() {
  const ws = new WebSocket(BRIDGE_WS);
  ws.on('open', () => {
    delay = 1000;
    console.log(`[luna-sidecar] connected to ${BRIDGE_WS}`);
    ws.send(JSON.stringify({ type: 'hello', name: `sidecar-${process.platform}` }));
  });
  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type !== 'execute' || !msg.id) return;
    try {
      const out = await forward(msg.script);
      ws.send(JSON.stringify({ id: msg.id, type: 'result', ok: true, data: out }));
    } catch (e) {
      ws.send(JSON.stringify({ id: msg.id, type: 'result', ok: false, error: e.message }));
    }
  });
  const onDrop = (why) => {
    if (stopping) return;
    console.log(`[luna-sidecar] disconnected (${why}) — retrying in ${delay / 1000}s`);
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 15_000);
  };
  ws.on('close', () => onDrop('close'));
  ws.on('error', () => onDrop('error'));
}

process.on('SIGINT', () => {
  stopping = true;
  console.log('\n[luna-sidecar] bye');
  process.exit(0);
});

connect();
