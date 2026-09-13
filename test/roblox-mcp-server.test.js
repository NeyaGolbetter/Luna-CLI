import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { startBridge } = await import('../dist/bridge/roblox-bridge.js');
const { WebSocket } = await import('ws');
const { McpManager } = await import('../dist/mcp/manager.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const robloxServer = path.join(here, '..', 'mcp-servers', 'roblox_server.js');

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

test('shipped roblox_server.js (stdio) drives the bridge end-to-end', async () => {
  const port = await freePort();
  const bridge = await startBridge({ port, host: '127.0.0.1' });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r, j) => {
      ws.on('open', r);
      ws.on('error', j);
    });
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'execute') {
        ws.send(JSON.stringify({ id: m.id, type: 'result', ok: true, data: `stdout:${m.script.length}` }));
      }
    });
    await new Promise((r) => setTimeout(r, 200));

    const mcp = new McpManager();
    await mcp.connectAll({
      mcpServers: {
        'roblox-executor': {
          command: process.execPath,
          args: [robloxServer],
          env: { LUNA_BRIDGE_URL: `http://127.0.0.1:${port}` },
        },
      },
    });
    try {
      assert.equal(mcp.servers.length, 1);
      const tools = mcp.servers[0].tools.map((t) => t.name);
      assert.ok(tools.includes('run_luau_script'));
      assert.ok(tools.includes('get_game_state'));
      assert.ok(tools.includes('get_bridge_status'));

      const out = await mcp.callTool('run_luau_script', { script: 'print("from stdio server")' });
      assert.equal(out, `stdout:${'print("from stdio server")'.length}`);

      const st = await mcp.callTool('get_bridge_status', {});
      assert.match(st, /"attached":\s*true/);
    } finally {
      await mcp.disconnectAll();
    }
    ws.close();
  } finally {
    await bridge.close();
  }
});

test('roblox_server.js reports a friendly error when the bridge is down', async () => {
  const mcp = new McpManager();
  await mcp.connectAll({
    mcpServers: {
      'roblox-executor': {
        command: process.execPath,
        args: [robloxServer],
        env: { LUNA_BRIDGE_URL: 'http://127.0.0.1:1' },
      },
    },
  });
  try {
    assert.equal(mcp.servers.length, 1);
    await assert.rejects(
      () => mcp.callTool('run_luau_script', { script: 'x' }),
      /EXECUTOR ERROR|ECONNREFUSED|bridge/,
    );
  } finally {
    await mcp.disconnectAll();
  }
});
