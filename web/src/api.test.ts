import assert from 'node:assert/strict';
import test from 'node:test';
import { generate, getConfig, type GenerateEvent } from './api.ts';

const stats = { ttftMs: 42, totalMs: 1250, outputTokens: 900, tokensPerSecond: 800, tokensEstimated: true };

function streamResponse(chunks: Uint8Array[]) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }));
}

test('POSTs the request and parses split SSE lines and UTF-8 characters', async (t) => {
  const body = { prompt: 'A sun', lane: 'cerebras' as const, conversationId: 'app-id', remixOf: 'parent-app', runId: '0123456789abcdef0123456789abcdef' };
  const signal = new AbortController().signal;
  const events: GenerateEvent[] = [];
  const expected: GenerateEvent[] = [{ type: 'queue', position: 3 }, { type: 'queue', position: 0 }, { type: 'status', variant: 0, phase: 'waiting_model' }, { type: 'delta', variant: 0, text: '☀️\n<html>' }, { type: 'done', variant: 0, stats, appId: 'saved-id' }, { type: 'end' }];
  const bytes = new TextEncoder().encode(': heartbeat\r\nevent: message\r\n' + expected.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, '/api/generate');
    assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(init.body as string), body);
    assert.equal(init.signal, signal);
    return streamResponse(Array.from(bytes, byte => Uint8Array.of(byte)));
  });
  await generate(body, event => events.push(event), signal);
  assert.deepEqual(events, expected);
});

test('parses an error event without a trailing newline', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => streamResponse([new TextEncoder().encode('data: {"type":"error","variant":0,"message":"Provider unavailable","retryable":true}\n\ndata: {"type":"end"}')]));
  const events: GenerateEvent[] = [];
  await generate({ prompt: 'App', lane: 'compare' }, event => events.push(event), new AbortController().signal);
  assert.deepEqual(events, [{ type: 'error', variant: 0, message: 'Provider unavailable', retryable: true }, { type: 'end' }]);
});

test('finishes on a terminal event without waiting for the connection to close', async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'done', variant: 0, stats, appId: null })}\n\ndata: {"type":"end"}\n\n`)); },
    cancel() { cancelled = true; },
  })));
  await generate({ prompt: 'App', lane: 'cerebras' }, () => {}, new AbortController().signal);
  assert.equal(cancelled, true);
});

test('reports HTTP errors and missing response bodies', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('secret upstream text', { status: 503 }));
  await assert.rejects(generate({ prompt: 'App', lane: 'cerebras' }, () => {}, new AbortController().signal), /Blink is very busy/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response(null));
  await assert.rejects(generate({ prompt: 'App', lane: 'cerebras' }, () => {}, new AbortController().signal), /stream/i);
});

test('reports malformed events and streams that end before completion', async (t) => {
  for (const content of ['data: broken\n', 'data: {"type":"delta","text":3}\n', 'data: {"type":"delta","text":"partial"}\n']) {
    t.mock.method(globalThis, 'fetch', async () => streamResponse([new TextEncoder().encode(content)]));
    await assert.rejects(generate({ prompt: 'App', lane: 'cerebras' }, () => {}, new AbortController().signal));
    t.mock.restoreAll();
  }
});

test('propagates cancellation and stream read failures', async (t) => {
  const controller = new AbortController();
  controller.abort();
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    init.signal!.throwIfAborted();
    return new Response(null);
  });
  await assert.rejects(generate({ prompt: 'App', lane: 'cerebras' }, () => {}, controller.signal), { name: 'AbortError' });
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(stream) { stream.error(new Error('Connection lost')); },
  })));
  await assert.rejects(generate({ prompt: 'App', lane: 'cerebras' }, () => {}, new AbortController().signal), /Connection lost/);
});

test('loads configuration and reports HTTP failure', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, '/api/config');
    return Response.json({ modelLabel: 'Kimi K3.1 Pro on Cerebras', compareEnabled: true, compareLabel: 'GPU provider', variantsEnabled: true, maxPromptChars: 500, publicOrigin: null });
  });
  assert.deepEqual(await getConfig(), { modelLabel: 'Kimi K3.1 Pro on Cerebras', compareEnabled: true, compareLabel: 'GPU provider', variantsEnabled: true, maxPromptChars: 500, publicOrigin: null });
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 500 }));
  await assert.rejects(getConfig(), /500/);
});

test('supports disabled comparison and rejects malformed configuration', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ modelLabel: 'Kimi K3.1 Pro on Cerebras', compareEnabled: false, compareLabel: null, variantsEnabled: true, maxPromptChars: 500, publicOrigin: null }));
  assert.deepEqual(await getConfig(), { modelLabel: 'Kimi K3.1 Pro on Cerebras', compareEnabled: false, compareLabel: null, variantsEnabled: true, maxPromptChars: 500, publicOrigin: null });
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ modelLabel: 'Kimi K3.1 Pro on Cerebras', compareEnabled: 'true', compareLabel: null, variantsEnabled: true, maxPromptChars: 500, publicOrigin: null }));
  await assert.rejects(getConfig(), /Invalid configuration/);
});

test('rejects missing or invalid model labels in configuration', async t => {
  for (const modelLabel of [undefined, null, 42]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ modelLabel, compareEnabled: false, compareLabel: null, variantsEnabled: true, maxPromptChars: 500, publicOrigin: null }));
    await assert.rejects(getConfig(), /Invalid configuration/);
    t.mock.restoreAll();
  }
});

for (const status of [429, 503]) {
  test(`HTTP ${status} includes a friendly message and retryAfterSec`, async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'busy', retryAfterSec: 23 }, { status }));
    await assert.rejects(generate({ prompt: 'App' }, () => {}, new AbortController().signal), (error: any) => {
      assert.equal(error.retryAfterSec, 23);
      assert.equal(error.retryable, true);
      assert.match(error.message, status === 503 ? /Blink is very busy/ : /Blink’s limit/);
      assert.match(error.message, /23 s/);
      return true;
    });
  });
}

test('keeps reading all four variants after done/error until end', async t => {
  const expected: GenerateEvent[] = [
    { type: 'queue', position: 2 },
    { type: 'status', variant: 3, phase: 'waiting_model' },
    { type: 'delta', variant: 3, text: 'fourth' },
    { type: 'done', variant: 3, stats, appId: 'four' },
    { type: 'error', variant: 1, message: 'Paused', retryable: false },
    { type: 'delta', variant: 0, text: 'first' },
    { type: 'done', variant: 0, stats, appId: 'one' },
    { type: 'done', variant: 2, stats, appId: null },
    { type: 'end' },
  ];
  t.mock.method(globalThis, 'fetch', async () => streamResponse([new TextEncoder().encode(expected.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))]));
  const events: GenerateEvent[] = [];
  await generate({ prompt: 'App', variants: 4 }, event => events.push(event), new AbortController().signal);
  assert.deepEqual(events, expected);
});

test('rejects missing variant tags, early end and out-of-range variants', async t => {
  for (const event of [
    { type: 'delta', text: 'missing variant' },
    { type: 'delta', variant: 1, text: 'unexpected variant for solo' },
    { type: 'queue', position: -1 },
    { type: 'error', variant: 0, message: 'Missing retryable' },
    { type: 'end' },
  ]) {
    t.mock.method(globalThis, 'fetch', async () => streamResponse([new TextEncoder().encode(`data: ${JSON.stringify(event)}\n`)]));
    await assert.rejects(generate({ prompt: 'App' }, () => {}, new AbortController().signal));
    t.mock.restoreAll();
  }
});
