import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAppServer } from './index.ts';
import { httpHarness } from './test-http.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const harnesses = new WeakMap<TestContext, ReturnType<typeof httpHarness>>();
async function listen(t: TestContext, server: Server) {
  if (!harnesses.has(t)) harnesses.set(t, httpHarness(t));
  return harnesses.get(t)!(server);
}

function events(body: string) {
  return body.split('\n\n').filter(Boolean).map(line => {
    assert.ok(line.startsWith('data: '));
    return JSON.parse(line.slice(6));
  });
}

async function generate(url: string, body: unknown) {
  return fetch(`${url}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('the server entry point binds loopback by default for start and dev, and honors HOST', () => {
  const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
  const env = { ...process.env };
  delete env.HOST;
  delete env.PORT;
  for (const [overrides, expected] of [
    [{}, { port: 5173, host: '127.0.0.1' }],
    [{ PORT: '5174' }, { port: 5174, host: '127.0.0.1' }],
    [{ HOST: '0.0.0.0' }, { port: 5173, host: '0.0.0.0' }],
  ] as const) {
    // Capture the actual entry point's listen arguments without opening sockets.
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { Server } from 'node:http';
      process.argv[1] = ${JSON.stringify(entry)};
      Server.prototype.listen = function (port, host) {
        console.log(JSON.stringify({ port, host }));
        return this;
      };
      await import(${JSON.stringify(entry)});
    `], { env: { ...env, ...overrides }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
});

test('rejects non-JSON API writes with 415 JSON before calling upstream', async t => {
  let upstreamCalls = 0;
  const upstream = await listen(t, createServer((_req, res) => {
    upstreamCalls++;
    res.end('data: [DONE]\n\n');
  }));
  const url = await listen(t, createAppServer({ OPENCLAW_BASE_URL: upstream }));
  const body = JSON.stringify({ prompt: 'a clock', lane: 'cerebras' });
  for (const contentType of ['text/plain', 'application/jsonp', undefined]) {
    for (const [method, path] of [['POST', '/api/generate'], ['PUT', '/api/config'], ['DELETE', '/api/other'], ['PATCH', '/api']]) {
      const response = await fetch(`${url}${path}`, {
        method, headers: { 'Content-Length': String(Buffer.byteLength(body)), ...(contentType ? { 'Content-Type': contentType } : {}) },
        body,
      });
      assert.equal(response.status, 415);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      assert.equal(typeof (await response.json()).error, 'string');
    }
  }
  assert.equal(upstreamCalls, 0);
});

test('rejects foreign origins on API writes with 403 JSON before calling upstream', async t => {
  let upstreamCalls = 0;
  const upstream = await listen(t, createServer((_req, res) => {
    upstreamCalls++;
    res.end('data: [DONE]\n\n');
  }));
  const url = await listen(t, createAppServer({ OPENCLAW_BASE_URL: upstream }));
  const body = JSON.stringify({ prompt: 'a clock', lane: 'cerebras' });
  for (const origin of ['https://foreign.example', 'null', `${url}.evil.example`, 'http://localhost:51730']) {
    for (const [method, path] of [['POST', '/api/generate'], ['PUT', '/api/config'], ['DELETE', '/api/other'], ['PATCH', '/api']]) {
      const response = await fetch(`${url}${path}`, {
        method, headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), Origin: origin },
        body,
      });
      assert.equal(response.status, 403);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      assert.equal(typeof (await response.json()).error, 'string');
    }
  }
  assert.equal(upstreamCalls, 0);
});

test('allows same-origin, both dev origins, configured origins, and no Origin with JSON charset', async t => {
  let upstreamCalls = 0;
  const upstream = await listen(t, createServer((_req, res) => {
    upstreamCalls++;
    res.end('data: [DONE]\n\n');
  }));
  const url = await listen(t, createAppServer({
    OPENCLAW_BASE_URL: upstream,
    BLINK_ALLOWED_ORIGINS: ' https://one.example, , https://two.example ',
  }));
  const origins = [url, 'http://127.0.0.1:5173', 'http://localhost:5173', 'https://one.example', 'https://two.example', undefined];
  for (const origin of origins) {
    const response = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ prompt: 'a clock', lane: 'cerebras' }),
    });
    assert.equal(response.status, 200);
    assert.equal(events(await response.text())[0].type, 'done');
  }
  assert.equal(upstreamCalls, origins.length);
  const config = await fetch(`${url}/api/config`, { headers: { Origin: 'https://foreign.example' } });
  assert.equal(config.status, 200);
  await config.json();
});

for (const lane of ['cerebras', 'compare'] as const) {
  test(`${lane} forwards the contract to its upstream and streams deltas and measured stats`, { timeout: 5000 }, async t => {
    let received: { path?: string; authorization?: string; body: any } | undefined;
    const upstream = await listen(t, createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      received = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"<html>"}}]}\n\n');
      setTimeout(() => {
        res.write('da');
        res.end('ta: {"choices":[{"delta":{"content":"🌟</html>"}}]}\n\ndata: {"choices":[],"usage":{"completion_tokens":10}}\n\ndata: [DONE]\n\n');
      }, 15);
    }));
    const url = await listen(t, createAppServer({
      OPENCLAW_BASE_URL: upstream,
      OPENCLAW_GATEWAY_TOKEN: 'gateway-secret',
      COMPARE_BASE_URL: `${upstream}/v1/`,
      COMPARE_API_KEY: 'compare-secret', COMPARE_MODEL: 'gpu-model', COMPARE_LABEL: 'GPU',
    }));
    const response = await generate(url, {
      prompt: 'make it blue', currentHtml: '<html>old</html>', conversationId: 'conversation-123', lane,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    const stream = events(await response.text());
    assert.deepEqual(stream.slice(0, 2), [
      { type: 'delta', text: '<html>' }, { type: 'delta', text: '🌟</html>' },
    ]);
    assert.equal(stream.length, 3);
    assert.equal(stream[2].type, 'done');
    const stats = stream[2].stats;
    assert.deepEqual(Object.keys(stats).sort(), ['ttftMs', 'totalMs', 'outputTokens', 'tokensPerSecond', 'tokensEstimated'].sort());
    assert.equal(stats.outputTokens, 10);
    assert.equal(stats.tokensEstimated, false);
    assert.ok(stats.ttftMs >= 0 && stats.totalMs >= stats.ttftMs);
    assert.ok(Number.isFinite(stats.tokensPerSecond) && stats.tokensPerSecond > 0);
    assert.ok(received);
    assert.equal(received.path, '/v1/chat/completions');
    assert.equal(received.authorization, `Bearer ${lane === 'cerebras' ? 'gateway-secret' : 'compare-secret'}`);
    assert.equal(received.body.model, lane === 'cerebras' ? 'openclaw/blink' : 'gpu-model');
    assert.equal(received.body.stream, true);
    assert.equal(received.body.user, 'conversation-123');
    const expectedMessages = [{
      role: 'user',
      content: 'Here is the current app:\n<html>old</html>\n\nChange it: make it blue. Return the complete updated HTML file.',
    }];
    if (lane === 'compare') expectedMessages.unshift({
      role: 'system', content: await readFile(new URL('../agent/AGENTS.md', import.meta.url), 'utf8'),
    });
    assert.deepEqual(received.body.messages, expectedMessages);
  });
}

test('omits unset gateway authorization, assigns a conversation, and estimates tokens without usage', async t => {
  let received: any;
  const upstream = await listen(t, createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received = { headers: req.headers, body: JSON.parse(body) };
    res.end('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n');
  }));
  const url = await listen(t, createAppServer({ OPENCLAW_BASE_URL: upstream }));
  const response = await generate(url, { prompt: 'a clock', lane: 'cerebras' });
  const stream = events(await response.text());
  assert.equal(received.headers.authorization, undefined);
  assert.equal(typeof received.body.user, 'string');
  assert.ok(received.body.user.length > 0);
  assert.deepEqual(received.body.messages, [{ role: 'user', content: 'a clock' }]);
  assert.equal(stream[1].stats.outputTokens, 2);
  assert.equal(stream[1].stats.tokensEstimated, true);
  assert.equal(stream[1].stats.tokensPerSecond, 0);
});

for (const failure of ['http', 'network', 'stream', 'malformed'] as const) {
  test(`${failure} upstream failure becomes a safe error event without done`, { timeout: 5000 }, async t => {
    const handler: RequestListener = (req, res) => {
      if (failure === 'network') return req.socket.destroy();
      if (failure === 'http') {
        res.writeHead(401);
        res.end('gateway-secret compare-secret provider-internal-error');
      } else {
        res.end(failure === 'stream'
          ? 'data: {"error":{"message":"gateway-secret compare-secret provider-internal-error"}}\n\n'
          : 'data: gateway-secret compare-secret provider-internal-error\n\n');
      }
    };
    const upstream = await listen(t, createServer(handler));
    const url = await listen(t, createAppServer({ OPENCLAW_BASE_URL: upstream, OPENCLAW_GATEWAY_TOKEN: 'gateway-secret' }));
    const response = await generate(url, { prompt: 'a clock', lane: 'cerebras' });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /gateway-secret|compare-secret|provider-internal-error/);
    const stream = events(text);
    assert.equal(stream.length, 1);
    assert.equal(stream[0].type, 'error');
    assert.equal(typeof stream[0].message, 'string');
    assert.ok(stream[0].message.length > 0 && stream[0].message.length < 100);
    assert.deepEqual(Object.keys(stream[0]).sort(), ['message', 'type']);
  });
}

test('rejects invalid JSON, types, lengths, and disabled lanes with 400 JSON before calling upstream', async t => {
  let upstreamCalls = 0;
  const upstream = await listen(t, createServer((_req, res) => {
    upstreamCalls++;
    res.end('data: [DONE]\n\n');
  }));
  const url = await listen(t, createAppServer({ OPENCLAW_BASE_URL: upstream }));
  for (const body of [
    null, [], 'prompt', {},
    { prompt: '', lane: 'cerebras' }, { prompt: '  ', lane: 'cerebras' },
    { prompt: 1, lane: 'cerebras' }, { prompt: 'x'.repeat(4001), lane: 'cerebras' },
    { prompt: 'a', lane: 'unknown' }, { prompt: 'a' }, { prompt: 'a', lane: 'compare' },
    { prompt: 'a', lane: 'cerebras', currentHtml: 1 },
    { prompt: 'a', lane: 'cerebras', currentHtml: 'x'.repeat(200001) },
    { prompt: 'a', lane: 'cerebras', conversationId: 42 },
  ]) {
    const response = await generate(url, body);
    assert.equal(response.status, 400);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  const malformed = await fetch(`${url}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal(typeof (await malformed.json()).error, 'string');
  const oversized = await fetch(`${url}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(2_000_001) });
  assert.equal(oversized.status, 400);
  assert.equal(typeof (await oversized.json()).error, 'string');
  assert.equal(upstreamCalls, 0);
  const valid = await generate(url, { prompt: 'x'.repeat(4000), currentHtml: 'x'.repeat(200000), lane: 'cerebras' });
  assert.equal(valid.status, 200);
  assert.equal(events(await valid.text())[0].type, 'done');
  assert.equal(upstreamCalls, 1);
});

test('/api/config enables comparison only when all four compare variables are present', async t => {
  const complete = {
    COMPARE_BASE_URL: 'http://provider/v1', COMPARE_API_KEY: 'secret', COMPARE_MODEL: 'model', COMPARE_LABEL: 'GPU',
  };
  const enabled = await listen(t, createAppServer(complete));
  assert.deepEqual(await (await fetch(`${enabled}/api/config`)).json(), { compareEnabled: true, compareLabel: 'GPU' });
  for (const env of [{}, ...Object.keys(complete).map(key => ({ ...complete, [key]: '' }))]) {
    const url = await listen(t, createAppServer(env));
    assert.deepEqual(await (await fetch(`${url}/api/config`)).json(), { compareEnabled: false, compareLabel: null });
  }
});

test('disconnecting a streaming client aborts the upstream response', { timeout: 5000 }, async t => {
  const closed = deferred();
  const upstream = await listen(t, createServer((_req, res) => {
    res.on('close', () => closed.resolve());
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
  }));
  const url = await listen(t, createAppServer({ OPENCLAW_BASE_URL: upstream }));
  const controller = new AbortController();
  const response = await fetch(`${url}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'a clock', lane: 'cerebras' }), signal: controller.signal,
  });
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  controller.abort();
  await closed.promise;
});

test('disconnecting before upstream headers aborts the pending upstream request', { timeout: 5000 }, async t => {
  const started = deferred();
  const closed = deferred();
  const upstream = await listen(t, createServer((_req, res) => {
    res.on('close', () => closed.resolve());
    started.resolve();
  }));
  const url = await listen(t, createAppServer({ OPENCLAW_BASE_URL: upstream }));
  const controller = new AbortController();
  const response = await fetch(`${url}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'a clock', lane: 'cerebras' }), signal: controller.signal,
  });
  await started.promise;
  controller.abort();
  // Consume the rejected response body so cancellation leaves no unhandled error.
  await assert.rejects(response.text());
  await closed.promise;
});

test('the three-minute timeout aborts a stalled upstream and sends an error event', { timeout: 5000 }, async t => {
  let expire: (() => void) | undefined;
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, delay: number, ...args: unknown[]) => {
    if (delay === 180_000) expire = callback;
    return realSetTimeout(callback, delay, ...args);
  });
  const started = deferred();
  const closed = deferred();
  const upstream = await listen(t, createServer((_req, res) => {
    res.on('close', () => closed.resolve());
    started.resolve();
  }));
  const url = await listen(t, createAppServer({ OPENCLAW_BASE_URL: upstream }));
  const response = await generate(url, { prompt: 'a clock', lane: 'cerebras' });
  await started.promise;
  assert.ok(expire, 'a timeout must be scheduled for 180000ms');
  expire();
  assert.deepEqual(events(await response.text()), [{ type: 'error', message: 'Generation timed out.' }]);
  await closed.promise;
});
