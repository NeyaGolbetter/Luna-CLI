import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LUNA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-mcp-'));

const {
  loadMcpConfig,
  saveMcpConfig,
  addMcpServer,
  removeMcpServer,
  serverTransport,
  serverEndpoint,
  sanitizeServerName,
  mcpConfigFile,
} = await import('../dist/utils/mcp-config.js');
const { LunaError } = await import('../dist/utils/errors.js');

test('empty when no file', () => {
  const cfg = loadMcpConfig();
  assert.deepEqual(cfg.mcpServers, {});
});

test('add stdio server', () => {
  addMcpServer('fs', { command: 'node', args: ['./fs.js'], env: { A: 'B' } });
  const cfg = loadMcpConfig();
  assert.equal(serverTransport(cfg.mcpServers.fs), 'stdio');
  assert.equal(serverEndpoint(cfg.mcpServers.fs), 'node ./fs.js');
  assert.deepEqual(cfg.mcpServers.fs.env, { A: 'B' });
});

test('add sse server (url detection + default transport)', () => {
  addMcpServer('remote-tunnel', { url: 'https://abc.trycloudflare.com/sse' });
  const cfg = loadMcpConfig();
  assert.equal(serverTransport(cfg.mcpServers['remote-tunnel']), 'sse');
});

test('add http (streamable) server', () => {
  addMcpServer('http-srv', { url: 'https://host/mcp', transport: 'http', headers: { Authorization: 'Bearer x' } });
  const cfg = loadMcpConfig();
  assert.equal(serverTransport(cfg.mcpServers['http-srv']), 'http');
});

test('remove server', () => {
  removeMcpServer('fs');
  assert.ok(!('fs' in loadMcpConfig().mcpServers));
  assert.throws(() => removeMcpServer('nope'), LunaError);
});

test('name validation', () => {
  assert.throws(() => sanitizeServerName('bad name!'), LunaError);
  assert.equal(sanitizeServerName('good_name-1'), 'good_name-1');
});

test('invalid file shape throws a clear error', () => {
  fs.writeFileSync(mcpConfigFile(), JSON.stringify({ nope: 1 }));
  assert.throws(() => loadMcpConfig(), /mcpServers/);
  // restore
  fs.unlinkSync(mcpConfigFile());
});
