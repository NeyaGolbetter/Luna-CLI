import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LUNA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-test-'));

const { config } = await import('../dist/utils/config.js');
const { configPath } = await import('../dist/utils/paths.js');

test('defaults are sensible', () => {
  const cfg = config.load();
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.apiKey, '');
  assert.equal(cfg.activeModel, '');
  assert.equal(cfg.temperature, 0.7);
  assert.equal(cfg.stream, true);
  assert.ok(typeof cfg.systemPrompt === 'string' && cfg.systemPrompt.length > 10);
});

test('save persists atomically and reloads', () => {
  config.save({ provider: 'openrouter', apiKey: 'sk-test-123456789', activeModel: 'anthropic/claude-sonnet-4' });
  assert.ok(fs.existsSync(configPath()));
  config.invalidate();
  const reloaded = config.load();
  assert.equal(reloaded.provider, 'openrouter');
  assert.equal(reloaded.apiKey, 'sk-test-123456789');
  assert.equal(reloaded.activeModel, 'anthropic/claude-sonnet-4');
});

test('baseUrlOf uses provider default unless overridden', () => {
  config.save({ provider: 'gemini', baseUrl: '' });
  assert.equal(config.baseUrlOf(), 'https://generativelanguage.googleapis.com/v1beta/openai');
  config.save({ baseUrl: 'http://127.0.0.1:11434/v1' });
  assert.equal(config.baseUrlOf(), 'http://127.0.0.1:11434/v1');
});

test('trailing slashes are normalized', () => {
  config.save({ baseUrl: 'http://host:9000/v1///' });
  assert.equal(config.baseUrlOf(), 'http://host:9000/v1');
});

test('maskKey keeps first/last chars only', () => {
  const m = config.maskKey('sk-abcdefghij1234567890');
  assert.ok(!m.includes('cdefgh'));
  assert.ok(m.startsWith('sk-a'));
  assert.ok(m.endsWith('7890'));
  assert.equal(config.maskKey(''), '(not set)');
});

test('unknown/legacy files merge over defaults without crashing', () => {
  const p = configPath();
  fs.writeFileSync(p, JSON.stringify({ provider: 'custom', weird: true, temperature: 99 }));
  config.invalidate();
  const cfg = config.load();
  assert.equal(cfg.provider, 'custom');
  assert.equal(cfg.temperature, 99);
  assert.ok(cfg.tunnel, 'tunnel state is normalized');
});

test('invalid provider falls back to default', () => {
  const p = configPath();
  fs.writeFileSync(p, JSON.stringify({ provider: 'nonsense' }));
  config.invalidate();
  assert.equal(config.load().provider, 'openai');
});
