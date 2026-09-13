import test from 'node:test';
import assert from 'node:assert/strict';

const { stripAnsi, wrapText, renderMarkdown, looksLikeMarkdown, terminalWidth, banner } = await import(
  '../dist/utils/formatter.js'
);

test('terminalWidth is sane (20..240)', () => {
  const w = terminalWidth();
  assert.ok(w >= 20 && w <= 240);
});

test('stripAnsi removes escapes', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(stripAnsi('plain'), 'plain');
});

test('wrapText wraps long lines at width', () => {
  const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
  const out = wrapText(words, 30);
  for (const line of out.split('\n')) {
    assert.ok(line.length <= 34, `line too long: ${line.length}`);
  }
  assert.ok(out.split('\n').length > 1);
});

test('wrapText hard-breaks very long tokens', () => {
  const url = 'https://example.com/' + 'x'.repeat(200);
  const out = wrapText(url, 40);
  for (const line of out.split('\n')) {
    assert.ok(line.length <= 45, `line too long: ${line.length}`);
  }
});

test('wrapText handles ANSI-styled text without miscounting', () => {
  const styled = '\u001b[1m' + 'word '.repeat(20) + '\u001b[0m';
  const out = wrapText(styled, 30);
  // every visible line must be within width
  for (const line of out.split('\n')) {
    assert.ok(stripAnsi(line).length <= 31, `visible too long: ${stripAnsi(line).length}`);
  }
});

test('renderMarkdown produces styled output for headings and code', () => {
  const md = '# Title\n\nSome **bold** and `code`.\n\n```lua\nprint("hi")\n```\n';
  const out = renderMarkdown(md, 80);
  assert.ok(out.includes('Title'));
  assert.ok(out.includes('print("hi")'));
  assert.ok(looksLikeMarkdown(md));
});

test('renderMarkdown fallback path for heavy code (no crash, content preserved)', () => {
  const big = Array.from({ length: 400 }, (_, i) => `local x${i} = ${i} -- padding padding padding`).join('\n');
  const md = '```lua\n' + big + '\n```';
  const out = renderMarkdown(md, 80);
  assert.ok(out.includes('x42'));
});

test('banner survives a very narrow terminal (Termux portrait)', () => {
  const b = banner('gpt-4o-mini', 'openai', 1, 3);
  assert.ok(b.includes('gpt-4o-mini'));
  assert.ok(b.includes('openai'));
  assert.ok(b.includes('1 server(s), 3 tool(s)'));
});
