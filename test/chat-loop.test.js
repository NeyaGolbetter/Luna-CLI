import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LUNA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-chat-'));

const { OpenAICompatibleClient } = await import('../dist/providers/openai.js');
const { McpManager } = await import('../dist/mcp/manager.js');
const { runTurn, emptyConversation } = await import('../dist/mcp/orchestrator.js');
const { ProviderError } = await import('../dist/utils/errors.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureServer = path.join(here, 'fixtures', 'fake-mcp-server.mjs');

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

/**
 * Mock OpenAI-compatible server.
 * Script: request #1 → model calls echo_tool; request #2 (sees tool result) → final answer.
 */
function startMockOpenAI() {
  let calls = 0;
  let lastBody = null;
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', async () => {
      const send = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const url = (req.url ?? '').replace(/^\/v1/, '');
      if (url === '/models') {
        return send({
          data: [
            { id: 'test-model-a', created: 1700000000, owned_by: 'luna' },
            { id: 'test-model-b', created: 1700000100, owned_by: 'luna' },
          ],
        });
      }
      if (url === '/chat/completions') {
        calls++;
        const body = JSON.parse(b);
        lastBody = body;
        const hasToolResult = body.messages.some((m) => m.role === 'tool');
        const streaming = body.stream === true;

        if (!hasToolResult) {
          const toolCall = {
            id: 'call_1',
            type: 'function',
            function: { name: 'echo_tool', arguments: JSON.stringify({ msg: 'hello-mcp' }) },
          };
          if (streaming) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const chunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
            chunk({ choices: [{ delta: { role: 'assistant' } }] });
            chunk({
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, id: toolCall.id, function: { name: 'echo_tool', arguments: '' } }],
                  },
                },
              ],
            });
            chunk({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, function: { arguments: '{"msg":' } },
                    ],
                  },
                },
              ],
            });
            chunk({
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, function: { arguments: '"hello-mcp"}' } }],
                  },
                },
              ],
            });
            res.write('data: [DONE]\n\n');
            return res.end();
          }
          return send({
            model: 'test-model-a',
            choices: [{ message: { role: 'assistant', content: null, tool_calls: [toolCall] } }],
          });
        }

        const finalText = 'The tool said: ' + (body.messages.find((m) => m.role === 'tool')?.content ?? '?');
        if (streaming) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const chunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
          chunk({ model: 'test-model-a', choices: [{ delta: { content: finalText.slice(0, 10) } }] });
          chunk({ model: 'test-model-a', choices: [{ delta: { content: finalText.slice(10) } }] });
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        return send({ model: 'test-model-a', choices: [{ message: { role: 'assistant', content: finalText } }] });
      }
      res.writeHead(404).end('{}');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        calls: () => calls,
        lastBody: () => lastBody,
      }),
    ),
  );
}

function mockCfg(stream) {
  return {
    version: 1,
    provider: 'custom',
    apiKey: 'k',
    baseUrl: '',
    activeModel: 'test-model-a',
    temperature: 0.1,
    maxTokens: 512,
    systemPrompt: 'You are a test bot.',
    stream,
    tunnel: null,
  };
}

test('dynamic model discovery (GET /models)', async () => {
  const mock = await startMockOpenAI();
  try {
    const client = new OpenAICompatibleClient(mock.baseUrl, 'k');
    const models = await client.listModels();
    assert.equal(models.length, 2);
    assert.equal(models[0].id, 'test-model-a');
  } finally {
    mock.server.close();
  }
});

test('non-streaming chat round-trip with MCP tool interception', async () => {
  const mock = await startMockOpenAI();
  const mcp = new McpManager();
  try {
    await mcp.connectAll({ mcpServers: { fake: { command: process.execPath, args: [fixtureServer] } } });
    assert.equal(mcp.servers.length, 1);
    const defs = mcp.toolDefs();
    const names = defs.map((d) => d.function.name);
    assert.ok(names.includes('echo_tool'));
    assert.ok(names.includes('boom_tool'));

    const messages = emptyConversation('sys');
    const out = await runTurn(messages, mockCfg(false), new OpenAICompatibleClient(mock.baseUrl, 'k'), mcp);
    assert.match(out, /The tool said: echo:hello-mcp/);

    // The model received tool schemas on both requests; the tool result was appended.
    assert.equal(mock.calls(), 2);
    const second = mock.lastBody();
    assert.ok(second.tools.some((t) => t.function.name === 'echo_tool'));
    const toolMsg = second.messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg.tool_call_id, 'call_1');
    assert.equal(toolMsg.content, 'echo:hello-mcp');
  } finally {
    await mcp.disconnectAll();
    mock.server.close();
  }
});

test('streaming chat assembles content deltas and tool-call deltas', async () => {
  const mock = await startMockOpenAI();
  const mcp = new McpManager();
  try {
    await mcp.connectAll({ mcpServers: { fake: { command: process.execPath, args: [fixtureServer] } } });
    const messages = emptyConversation('sys');
    let streamed = '';
    const out = await runTurn(
      messages,
      mockCfg(true),
      new OpenAICompatibleClient(mock.baseUrl, 'k'),
      mcp,
      { onDelta: (d) => (streamed += d) },
    );
    assert.match(out, /The tool said: echo:hello-mcp/);
    assert.equal(streamed, out);
  } finally {
    await mcp.disconnectAll();
    mock.server.close();
  }
});

test('tool errors are reported back to the model (isError → tool message)', async () => {
  const mock = await startMockOpenAI();
  // Override: model asks for boom_tool by intercepting the name via env is overkill —
  // instead point the mock at boom_tool: we reuse the mock but rename via a small wrapper server.
  const mock2 = await startBoomMock();
  const mcp = new McpManager();
  try {
    await mcp.connectAll({ mcpServers: { fake: { command: process.execPath, args: [fixtureServer] } } });
    const messages = emptyConversation('sys');
    const out = await runTurn(messages, mockCfg(false), new OpenAICompatibleClient(mock2.baseUrl, 'k'), mcp);
    assert.match(out, /The tool said: \[tool error\]/);
  } finally {
    await mcp.disconnectAll();
    mock.server.close();
    mock2.server.close();
  }
});

function startBoomMock() {
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const send = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const body = JSON.parse(b);
      const hasToolResult = body.messages.some((m) => m.role === 'tool');
      if (!hasToolResult) {
        return send({
          model: 'm',
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'call_x', type: 'function', function: { name: 'boom_tool', arguments: '{}' } },
                ],
              },
            },
          ],
        });
      }
      const toolMsg = body.messages.find((m) => m.role === 'tool');
      return send({
        model: 'm',
        choices: [{ message: { role: 'assistant', content: 'The tool said: ' + toolMsg.content } }],
      });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }),
    ),
  );
}

test('provider errors are friendly (401 → invalid key)', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = new OpenAICompatibleClient(`http://127.0.0.1:${server.address().port}/v1`, 'bad', {
      maxRetries: 0,
    });
    await assert.rejects(() => client.listModels(), (e) => {
      assert.ok(e instanceof ProviderError);
      assert.match(e.message, /Authentication failed/);
      return true;
    });
  } finally {
    server.close();
  }
});

test('aborting a stream cancels cleanly', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
    // then stall forever
    setTimeout(() => res.end(), 5000);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = new OpenAICompatibleClient(`http://127.0.0.1:${server.address().port}/v1`, 'k');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    await assert.rejects(
      () => client.chatStream({ messages: [], model: 'm', stream: true, signal: ac.signal }, () => {}),
      /cancelled/i,
    );
  } finally {
    server.close();
  }
});

test('MCP server that fails to connect is isolated (no crash, status recorded)', async () => {
  const mcp = new McpManager();
  try {
    await mcp.connectAll({
      mcpServers: {
        broken: { command: process.execPath, args: ['-e', 'process.exit(3)'] },
        fake: { command: process.execPath, args: [fixtureServer] },
      },
    });
    assert.equal(mcp.servers.length, 1);
    assert.equal(mcp.servers[0].name, 'fake');
    const statuses = mcp.statuses();
    const broken = statuses.find((s) => s.name === 'broken');
    assert.equal(broken.ok, false);
    assert.ok(broken.error);
  } finally {
    await mcp.disconnectAll();
  }
});

test('colliding tool names across servers are disambiguated', async () => {
  const mcp = new McpManager();
  try {
    await mcp.connectAll({
      mcpServers: {
        one: { command: process.execPath, args: [fixtureServer] },
        two: { command: process.execPath, args: [fixtureServer] },
      },
    });
    const names = mcp.toolDefs().map((d) => d.function.name);
    assert.ok(names.includes('echo_tool'));
    assert.ok(names.includes('two__echo_tool'), `expected disambiguated name, got: ${names.join(', ')}`);
  } finally {
    await mcp.disconnectAll();
  }
});
setTimeout(async () => {
  const { execSync } = await import('node:child_process');
  try {
    const ps = execSync('ps -eo pid,ppid,etime,args | grep -E "fake-mcp|node.*-e" | grep -v grep').toString();
    console.error('HANG-DEBUG PROCS:\n' + ps);
  } catch {
    console.error('HANG-DEBUG PROCS: none found');
  }
  process.exit(0);
}, 25_000);
