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
  const body = { prompt: 'A sun', lane: 'cerebras' as const, conversationId: 'app-id', currentHtml: '<html></html>' };
  const signal = new AbortController().signal;
  const events: GenerateEvent[] = [];
  const expected: GenerateEvent[] = [{ type: 'delta', text: '☀️\n<html>' }, { type: 'done', stats }];
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
  t.mock.method(globalThis, 'fetch', async () => streamResponse([new TextEncoder().encode('data: {"type":"error","message":"Provider unavailable"}')]));
  const events: GenerateEvent[] = [];
  await generate({ prompt: 'App', lane: 'compare' }, event => events.push(event), new AbortController().signal);
  assert.deepEqual(events, [{ type: 'error', message: 'Provider unavailable' }]);
});

test('finishes on a terminal event without waiting for the connection to close', async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'done', stats })}\n\n`)); },
    cancel() { cancelled = true; },
  })));
  await generate({ prompt: 'App', lane: 'cerebras' }, () => {}, new AbortController().signal);
  assert.equal(cancelled, true);
});

test('reports HTTP errors and missing response bodies', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('secret upstream text', { status: 503 }));
  await assert.rejects(generate({ prompt: 'App', lane: 'cerebras' }, () => {}, new AbortController().signal), /503/);
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
    return Response.json({ compareEnabled: true, compareLabel: 'GPU provider' });
  });
  assert.deepEqual(await getConfig(), { compareEnabled: true, compareLabel: 'GPU provider' });
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 500 }));
  await assert.rejects(getConfig(), /500/);
});

test('supports disabled comparison and rejects malformed configuration', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ compareEnabled: false, compareLabel: null }));
  assert.deepEqual(await getConfig(), { compareEnabled: false, compareLabel: null });
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ compareEnabled: 'true', compareLabel: null }));
  await assert.rejects(getConfig(), /Invalid configuration/);
});
