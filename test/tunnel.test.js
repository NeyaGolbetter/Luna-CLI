import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-tunnel-'));
process.env.LUNA_HOME = home;

const { startTunnel, stopTunnel, tunnelStatus, readTunnelState, tunnelStateFile } = await import(
  '../dist/bridge/tunnel-manager.js'
);
const { loadMcpConfig } = await import('../dist/utils/mcp-config.js');
const { config } = await import('../dist/utils/config.js');
const { LunaError } = await import('../dist/utils/errors.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** Fake cloudflared: waits, prints a trycloudflare URL on stderr, then idles. */
function makeFakeCloudflared(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-cf-'));
  const script = path.join(dir, 'cloudflared');
  fs.writeFileSync(
    script,
    `#!/usr/bin/env node
process.stderr.write("READY\\n");
setTimeout(() => {
  process.stderr.write("${url}\\n");
}, 500);
setTimeout(() => {}, 300000); // idle until killed
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`,
    { mode: 0o755 },
  );
  return script;
}

test('startTunnel without cloudflared gives a helpful error', async () => {
  const port = await freePort();
  await assert.rejects(
    () => startTunnel({ port, bridge: false, cloudflared: '/nonexistent/cloudflared-xyz', registerMcp: false }),
    /cloudflared was not found/,
  );
});

test('startTunnel captures the ephemeral URL, injects config + MCP entry', async () => {
  const port = await freePort();
  const fake = makeFakeCloudflared('https://luna-test-abc123.trycloudflare.com');
  const state = await startTunnel({
    port,
    cloudflared: fake,
    bridge: false,
    urlTimeoutMs: 15_000,
    registerMcp: true,
    mcpName: 'remote-tunnel',
  });
  try {
    assert.equal(state.url, 'https://luna-test-abc123.trycloudflare.com');
    assert.equal(state.targetUrl, `http://localhost:${port}`);
    assert.ok(state.cfPid > 0);

    // state file + config injection
    assert.ok(fs.existsSync(tunnelStateFile()));
    assert.equal(config.get('tunnel').url, state.url);

    // MCP auto-registration
    const mcp = loadMcpConfig();
    assert.ok(mcp.mcpServers['remote-tunnel'], 'remote-tunnel MCP server registered');
    assert.equal(mcp.mcpServers['remote-tunnel'].url, 'https://luna-test-abc123.trycloudflare.com/sse');
    assert.equal(mcp.mcpServers['remote-tunnel'].transport, 'sse');

    assert.ok(tunnelStatus().running);
  } finally {
    await stopTunnel();
  }

  // after stop: state gone, config cleared, MCP entry removed, process dead
  assert.equal(readTunnelState(), null);
  assert.equal(config.get('tunnel')?.url ?? null, null);
  assert.ok(!('remote-tunnel' in loadMcpConfig().mcpServers));
  assert.ok(!tunnelStatus().running);
});

test('startTunnel with --bridge owns the bridge and stops it too', async () => {
  const port = await freePort();
  const fake = makeFakeCloudflared('https://luna-test-xyz789.trycloudflare.com');
  const state = await startTunnel({
    port,
    cloudflared: fake,
    bridge: true,
    urlTimeoutMs: 15_000,
    registerMcp: false,
  });
  try {
    assert.ok(state.bridgePid > 0);
    assert.equal(state.bridgeOwned, true);
    // bridge is actually serving
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name === undefined ? body.attached : body.attached, false);
  } finally {
    await stopTunnel();
  }
  // bridge process killed
  const { isPidAlive } = await import('../dist/utils/process.js');
  assert.ok(!isPidAlive(state.bridgePid));
  assert.ok(!isPidAlive(state.cfPid));
});

test('starting a second tunnel while one is running is rejected', async () => {
  const port = await freePort();
  const fake = makeFakeCloudflared('https://luna-test-two.trycloudflare.com');
  await startTunnel({ port, cloudflared: fake, bridge: false, urlTimeoutMs: 15_000, registerMcp: false });
  try {
    const port2 = await freePort();
    await assert.rejects(
      () => startTunnel({ port: port2, cloudflared: fake, bridge: false, registerMcp: false }),
      (e) => e instanceof LunaError && /already running/i.test(e.message),
    );
  } finally {
    await stopTunnel();
  }
});

test('stopTunnel with no state is a clear error', async () => {
  assert.equal(readTunnelState(), null);
  await assert.rejects(() => stopTunnel(), /No tunnel is running/i);
});
