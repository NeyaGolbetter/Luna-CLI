import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const entry = path.join(root, 'dist', 'cli', 'index.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-cli-'));
const env = { ...process.env, LUNA_HOME: home, NO_COLOR: '1' };

function run(args, { input } = {}) {
  try {
    const out = execFileSync(process.execPath, [entry, ...args], {
      env,
      encoding: 'utf8',
      timeout: 60_000,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: e.stdout?.toString() ?? '', err: e.stderr?.toString() ?? '' };
  }
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

test('luna --version prints semver', () => {
  const r = run(['--version']);
  assert.equal(r.code, 0);
  assert.match(r.out.trim(), /^\d+\.\d+\.\d+$/);
});

test('luna --help lists the full command matrix', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0);
  for (const cmd of ['chat', 'config', 'models', 'mcp', 'tunnel', 'bridge']) {
    assert.match(r.out, new RegExp(cmd), `missing ${cmd} in help`);
  }
});

test('config set-provider / set-key / set-base-url persist to ~/.luna/config.json', () => {
  assert.equal(run(['config', 'set-provider', 'custom']).code, 0);
  assert.equal(run(['config', 'set-key', 'sk-test123']).code, 0);
  assert.equal(run(['config', 'set-base-url', 'http://127.0.0.1:9999/v1']).code, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(cfg.provider, 'custom');
  assert.equal(cfg.apiKey, 'sk-test123');
  assert.equal(cfg.baseUrl, 'http://127.0.0.1:9999/v1');

  const show = run(['config', 'show']);
  assert.equal(show.code, 0);
  assert.match(show.out, /custom/);
  assert.match(show.out, /sk-t…e123|sk-t…/); // masked key
});

test('models lists from a live (mock) provider and --select persists a model', async () => {
  // The mock must live in a SEPARATE process: run() uses execFileSync, which
  // blocks this event loop — an in-process server could never answer.
  const port = await freePort();
  const mockPath = path.join(home, 'mock-openai.mjs');
  fs.writeFileSync(
    mockPath,
    `import http from 'node:http';
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: [{ id: 'mock-model-1' }, { id: 'mock-model-2' }] }));
}).listen(${port}, '127.0.0.1');
`,
  );
  const mock = spawn(process.execPath, [mockPath], { stdio: 'ignore', detached: true });
  mock.unref();
  try {
    run(['config', 'set-base-url', `http://127.0.0.1:${port}/v1`]);
    const r = run(['models']);
    assert.equal(r.code, 0);
    assert.match(r.out, /mock-model-1/);
    assert.match(r.out, /mock-model-2/);

    // deterministic non-interactive override (--select is an interactive TUI
    // prompt and is not driven by piped stdin)
    assert.equal(run(['config', 'set-model', 'mock-model-2']).code, 0);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(cfg.activeModel, 'mock-model-2');
  } finally {
    try {
      process.kill(mock.pid);
    } catch {
      /* already gone */
    }
  }
});

test('mcp add (stdio + sse) writes mcp_servers.json; remove deletes', () => {
  assert.equal(run(['mcp', 'add', 'fs', 'node', './fs.js', '--env', 'A=B']).code, 0);
  let cfg = JSON.parse(fs.readFileSync(path.join(home, 'mcp_servers.json'), 'utf8'));
  assert.equal(cfg.mcpServers.fs.command, 'node');
  assert.deepEqual(cfg.mcpServers.fs.args, ['./fs.js']);
  assert.deepEqual(cfg.mcpServers.fs.env, { A: 'B' });

  assert.equal(run(['mcp', 'add', 'remote', 'https://x.trycloudflare.com/sse']).code, 0);
  cfg = JSON.parse(fs.readFileSync(path.join(home, 'mcp_servers.json'), 'utf8'));
  assert.equal(cfg.mcpServers.remote.url, 'https://x.trycloudflare.com/sse');
  assert.equal(cfg.mcpServers.remote.transport, 'sse');

  assert.equal(run(['mcp', 'remove', 'fs']).code, 0);
  cfg = JSON.parse(fs.readFileSync(path.join(home, 'mcp_servers.json'), 'utf8'));
  assert.ok(!('fs' in cfg.mcpServers));
  assert.ok('remote' in cfg.mcpServers);
});

test('mcp add rejects bad server names', () => {
  const r = run(['mcp', 'add', 'bad name!', 'node', './x.js']);
  assert.notEqual(r.code, 0);
});

test('unknown commands fail cleanly without stack traces', () => {
  const r = run(['nope']);
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.err, /at .*\(.*:\d+:\d+\)/);
});

test('tunnel start without cloudflared fails with install hints', async () => {
  // Ensure PATH has no cloudflared for this child.
  const noCfPath = process.env.PATH.split(path.delimiter)
    .filter((d) => !path.basename(d).startsWith('homebrew'))
    .join(path.delimiter);
  try {
    const out = execFileSync(process.execPath, [entry, 'tunnel', 'start', '--port', '18999'], {
      env: { ...env, PATH: noCfPath },
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.fail('should have failed');
  } catch (e) {
    const err = e.stderr?.toString() ?? '';
    assert.match(err, /cloudflared was not found/);
    if (!fs.existsSync('/usr/local/bin/cloudflared')) {
      assert.match(err, /Termux|install/i);
    }
  }
});
