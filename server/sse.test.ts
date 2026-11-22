import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSse } from './sse.ts';

async function* chunks(parts: (string | Uint8Array)[]) {
  for (const part of parts) yield typeof part === 'string' ? new TextEncoder().encode(part) : part;
}

async function collect<T>(source: AsyncIterable<T>) {
  const results: T[] = [];
  for await (const item of source) results.push(item);
  return results;
}

test('parses deltas and final usage across split lines and CRLF', async () => {
  const events = await collect(parseSse(chunks([
    ': keepalive\r\nevent: message\r\nda',
    'ta: {"choices":[{"delta":{"role":"assistant"}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"content":"he',
    'llo"}}]}\r',
    '\n\ndata: {"choices":[{"delta":{"content":"!"}}]}\n\n',
    'data: {"choices":[],"usage":{"completion_tokens":12}}\n\n',
    'data: [DO', 'NE]\n\ndata: {"choices":[{"delta":{"content":"ignored"}}]}\n\n',
  ])));
  assert.deepEqual(events, [
    { type: 'delta', text: 'hello' },
    { type: 'delta', text: '!' },
    { type: 'usage', completionTokens: 12 },
  ]);
});

test('preserves UTF-8 split mid-character and processes an unterminated last line', async () => {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"🌟"}}]}');
  const split = bytes.indexOf(0xf0) + 2;
  assert.deepEqual(await collect(parseSse(chunks([bytes.slice(0, split), bytes.slice(split)]))), [
    { type: 'delta', text: '🌟' },
  ]);
});

test('captures usage alongside a delta, including zero tokens', async () => {
  assert.deepEqual(await collect(parseSse(chunks([
    'data: {"choices":[{"delta":{"content":"a"}}],"usage":{"completion_tokens":0}}\n\n',
  ]))), [{ type: 'delta', text: 'a' }, { type: 'usage', completionTokens: 0 }]);
});

test('preserves valid prompt and completion usage, including zero, for reconciliation', async () => {
  const usages = [
    { prompt_tokens: 3789, completion_tokens: 8000 },
    { prompt_tokens: 0, completion_tokens: 0 },
    { prompt_tokens: -1, completion_tokens: 8 },
    { prompt_tokens: '4000', completion_tokens: 8 },
    { prompt_tokens: 4000, completion_tokens: -1 },
    { prompt_tokens: 4000, completion_tokens: '8000' },
  ];
  assert.deepEqual(await collect(parseSse(chunks(usages.map(usage => `data: ${JSON.stringify({ usage })}\n\n`)))), [
    { type: 'usage', promptTokens: 3789, completionTokens: 8000 },
    { type: 'usage', promptTokens: 0, completionTokens: 0 },
    { type: 'usage', completionTokens: 8 },
    { type: 'usage', completionTokens: 8 },
  ]);
});

test('strict streaming rejects an abrupt EOF but accepts a split terminal marker', async () => {
  await assert.rejects(collect(parseSse(chunks(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']), true)));
  assert.deepEqual(await collect(parseSse(chunks(['data: [DO', 'NE]']), true)), []);
});

test('rejects malformed data and upstream stream errors', async () => {
  await assert.rejects(collect(parseSse(chunks(['data: not-json\n\n']))));
  await assert.rejects(collect(parseSse(chunks(['data: {"error":{"message":"secret"}}\n\n']))));
});
