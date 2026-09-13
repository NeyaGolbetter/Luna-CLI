import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

process.env.LUNA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-bridge-'));

const { startBridge } = await import('../dist/bridge/roblox-bridge.js');
const { WebSocket } = await import('ws');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('bridge /status reports not attached initially', async () => {
  const port = await freePort();
  const bridge = await startBridge({ port, host: '127.0.0.1' });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.attached, false);
    assert.equal(body.backend, 'none');
    assert.ok(body.version);
  } finally {
    await bridge.close();
  }
});

test('bridge execute without executor returns 502 with friendly error', async () => {
  const port = await freePort();
  const bridge = await startBridge({ port, host: '127.0.0.1' });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: 'return 1' }),
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /no executor attached/i);
  } finally {
    await bridge.close();
  }
});

test('WS companion: execute round-trip + status attached', async () => {
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
        let ok = true;
        let data = `ran:${m.script.length}chars`;
        if (m.script.includes('boom')) {
          ok = false;
          data = undefined;
        }
        ws.send(JSON.stringify({ id: m.id, type: 'result', ok, data, error: ok ? undefined : 'script blew up' }));
      }
    });
    await sleep(200);

    const st = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    assert.equal(st.attached, true);
    assert.equal(st.backend, 'ws-companion');

    const ok = await (await fetch(`http://127.0.0.1:${port}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: 'print("hi")' }),
    })).json();
    assert.equal(ok.ok, true);
    assert.equal(ok.data, 'ran:11chars');

    const bad = await fetch(`http://127.0.0.1:${port}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: 'boom' }),
    });
    assert.equal(bad.status, 502);
    const badBody = await bad.json();
    assert.match(badBody.error, /script blew up/);

    ws.close();
    await sleep(200);
    const st2 = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    assert.equal(st2.attached, false);
  } finally {
    await bridge.close();
  }
});

test('polling executor: job queue → poll → result round-trip', async () => {
  const port = await freePort();
  const bridge = await startBridge({ port, host: '127.0.0.1' });
  try {
    // Simulate the Luau polling client: register by polling, fetch the job, post the result.
    const execPromise = bridge.executeScript('local x = 41 + 1', 5000);

    let job = null;
    for (let i = 0; i < 50 && !job; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/execute/poll?id=test-client`);
      if (res.status === 200) job = await res.json();
      await sleep(100);
    }
    assert.ok(job, 'job should be handed out');
    assert.equal(job.script, 'local x = 41 + 1');

    // status should now report the polling backend
    const st = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    assert.equal(st.backend, 'polling');

    const res2 = await fetch(`http://127.0.0.1:${port}/execute/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: job.id, ok: true, data: '42' }),
    });
    assert.equal(res2.status, 200);
    assert.equal(await execPromise, '42');
  } finally {
    await bridge.close();
  }
});

test('polling executor: errors propagate to the caller', async () => {
  const port = await freePort();
  const bridge = await startBridge({ port, host: '127.0.0.1' });
  try {
    const execPromise = bridge.executeScript('bad', 5000).then(
      () => assert.fail('should have rejected'),
      (e) => e,
    );
    let job = null;
    for (let i = 0; i < 50 && !job; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/execute/poll`);
      if (res.status === 200) job = await res.json();
      await sleep(100);
    }
    await fetch(`http://127.0.0.1:${port}/execute/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: job.id, ok: false, error: 'attempt to index nil' }),
    });
    const err = await execPromise;
    assert.match(err.message, /attempt to index nil/);
  } finally {
    await bridge.close();
  }
});

test('direct HTTP executor backend', async () => {
  // Fake executor HTTP listener.
  const http = await import('node:http');
  const executor = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const { script } = JSON.parse(b);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`executor-ran:${script}`);
    });
  });
  await new Promise((r) => executor.listen(0, '127.0.0.1', r));
  const execPort = executor.address().port;

  const port = await freePort();
  const bridge = await startBridge({ port, host: '127.0.0.1', executorUrl: `http://127.0.0.1:${execPort}/run` });
  try {
    const out = await bridge.executeScript('print(1)');
    assert.equal(out, 'executor-ran:print(1)');
    const st = await bridge.statusInfo();
    assert.equal(st.backend, 'http');
  } finally {
    await bridge.close();
    executor.close();
  }
});

test('MCP over SSE: tools listed and callable through the bridge', async () => {
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
        ws.send(JSON.stringify({ id: m.id, type: 'result', ok: true, data: `mcp-ran:${m.script.slice(0, 12)}` }));
      }
    });
    await sleep(200);

    const client = new Client({ name: 'test-client', version: '1' });
    await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`)));
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    assert.ok(names.includes('run_luau_script'));
    assert.ok(names.includes('get_game_state'));
    assert.ok(names.includes('get_bridge_status'));

    const res = await client.callTool({ name: 'run_luau_script', arguments: { script: 'print("a")' } });
    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /mcp-ran:print\("a"\)/);

    const st = await client.callTool({ name: 'get_bridge_status', arguments: {} });
    assert.match(st.content[0].text, /"attached":\s*true/);

    await client.close();
    ws.close();
  } finally {
    await bridge.close();
  }
});

test('unknown routes return 404 JSON', async () => {
  const port = await freePort();
  const bridge = await startBridge({ port, host: '127.0.0.1' });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
  } finally {
    await bridge.close();
  }
});
