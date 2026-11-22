import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AppDatabase } from './db.ts';
import { createAppServer } from './index.ts';
import { httpHarness } from './test-http.ts';

const HTML = '<!doctype html><html><head><title>Clock</title></head><body>Hello</body></html>';
const CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:";
function events(text: string) { return text.split('\n\n').filter(Boolean).map(s => JSON.parse(s.slice(6))); }
function setup(t: TestContext, overrides: NodeJS.ProcessEnv = {}, handler: RequestListener = (_req, res) => {
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: HTML } }] })}\n\ndata: [DONE]\n\n`);
}) {
  const dir = mkdtempSync(join(tmpdir(), 'blink-v2-'));
  const listen = httpHarness(t);
  const upstream = listen(createServer(handler));
  const env = { ...overrides, BLINK_DATA_DIR: dir, BLINK_SALT: 'test', OPENCLAW_BASE_URL: upstream };
  const server = createAppServer(env);
  const db = new AppDatabase(env);
  const url = listen(server);
  t.after(() => { server.emit('close'); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const post = (path: string, body: unknown = {}, ip = '203.0.113.1', extra: Record<string, string> = {}) => fetch(`${url}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...extra }, body: JSON.stringify(body),
  });
  const get = (path: string, ip = '203.0.113.1') => fetch(`${url}${path}`, { headers: { 'CF-Connecting-IP': ip } });
  async function generate(body: unknown = { prompt: 'a clock' }, ip?: string) {
    const response = await post('/api/generate', body, ip);
    assert.equal(response.status, 200);
    return events(await response.text());
  }
  return { env, db, url, post, get, generate };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('x4 fans out concurrently, tags every variant, applies directions, and saves extracted HTML', async t => {
  const requests: any[] = [];
  const allStarted = deferred();
  const api = setup(t, {}, async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    requests.push(JSON.parse(text));
    if (requests.length === 4) allStarted.resolve();
    await allStarted.promise;
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Here it is:\n```html\n' + HTML + '\n```' } }] })}\n\ndata: [DONE]\n\n`);
  });
  const stream = await api.generate({ prompt: 'a clock', variants: 4 });
  assert.equal(requests.length, 4);
  assert.deepEqual(stream[0], { type: 'queue', position: 0 });
  assert.deepEqual(stream.at(-1), { type: 'end' });
  const ids = new Set<string>();
  for (let variant = 0; variant < 4; variant++) {
    const own = stream.filter(e => e.variant === variant);
    assert.deepEqual(own.map(e => e.type), ['status', 'delta', 'done']);
    assert.equal(own[0].phase, 'waiting_model');
    assert.match(own[2].appId, /^[A-Za-z0-9_-]{10}$/);
    ids.add(own[2].appId);
    const saved = api.db.get(own[2].appId)!;
    assert.equal(saved.html, HTML);
    assert.equal(saved.title, 'Clock');
    assert.equal(saved.prompt, 'a clock');
    assert.equal(saved.shared, false);
    assert.equal(saved.parentId, null);
  }
  assert.equal(ids.size, 4);
  for (const direction of ['classic, polished', 'bold, playful, surprising', 'minimal and elegant', 'retro / arcade']) {
    assert.ok(requests.some(r => r.messages[0].content.endsWith(`Creative direction: ${direction}.`)));
  }
  const bad = await api.post('/api/generate', { prompt: 'x', lane: 'compare', variants: 4 });
  assert.equal(bad.status, 400);
});

test('429 active/hourly and 503 queue-full are JSON before SSE; queued jobs receive positions', async t => {
  const gate = deferred();
  let calls = 0;
  const api = setup(t, { MAX_CONCURRENT: '1', MAX_QUEUE: '1', HOURLY_LIMIT: '1' }, async (_req, res) => {
    calls++;
    await gate.promise;
    res.end('data: [DONE]\n\n');
  });
  const first = await api.post('/api/generate', { prompt: 'one' });
  const active = await api.post('/api/generate', { prompt: 'two' });
  assert.equal(active.status, 429);
  assert.match(active.headers.get('content-type')!, /application\/json/);
  assert.deepEqual(await active.json(), { error: 'rate_limited', retryAfterSec: 1 });
  const waiting = await api.post('/api/generate', { prompt: 'three' }, '203.0.113.2');
  const full = await api.post('/api/generate', { prompt: 'four' }, '203.0.113.3');
  assert.equal(full.status, 503);
  assert.deepEqual(await full.json(), { error: 'busy', retryAfterSec: 30 });
  assert.equal(calls, 1);
  gate.resolve();
  await first.text();
  const stream = events(await waiting.text());
  assert.deepEqual(stream.filter(e => e.type === 'queue'), [{ type: 'queue', position: 1 }, { type: 'queue', position: 0 }]);
  const limited = await api.post('/api/generate', { prompt: 'five' });
  assert.equal(limited.status, 429);
  const body = await limited.json();
  assert.equal(body.error, 'rate_limited');
  assert.ok(body.retryAfterSec > 3500 && body.retryAfterSec <= 3600);
});

test('sharing is creator-only; metadata omits identity; private raw is creator-only and sandboxed', async t => {
  const api = setup(t);
  const done = (await api.generate()).find(e => e.type === 'done');
  const id = done.appId;
  const metadata = await (await api.get(`/api/apps/${id}`)).json();
  assert.deepEqual(Object.keys(metadata).sort(), ['id', 'title', 'prompt', 'createdAt', 'shared', 'parentId'].sort());
  assert.equal((await api.get(`/api/apps/${id}`, '203.0.113.2')).status, 404);
  assert.equal((await api.get(`/raw/${id}`, '203.0.113.2')).status, 404);
  assert.equal((await api.get(`/a/${id}`)).status, 404);
  const raw = await api.get(`/raw/${id}`);
  assert.equal(raw.headers.get('content-security-policy'), CSP);
  assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await raw.text(), HTML);
  assert.equal((await api.post(`/api/apps/${id}/share`, {}, '203.0.113.2')).status, 403);
  assert.deepEqual(await (await api.post(`/api/apps/${id}/share`)).json(), { url: `/a/${id}` });
  assert.equal((await api.get(`/raw/${id}`, '203.0.113.2')).status, 200);
  assert.equal((await api.get(`/api/apps/${id}`, '203.0.113.2')).status, 200);
  assert.equal((await api.get(`/a/${id}`)).status, 200);
  for (const path of ['/a/unknown', '/raw/unknown', '/api/apps/unknown']) assert.equal((await api.get(path)).status, 404);
});

test('share pages escape text and include absolute OG/Twitter URLs, isolated iframe, links, and report script', async t => {
  const api = setup(t, { BLINK_PUBLIC_ORIGIN: 'https://blink.example/' });
  const evil = '</title><script>alert("x")</script><title>&';
  const app = api.db.save({ title: evil, prompt: '\"><img src=x onerror=alert(1)>&', html: HTML, ipHash: 'hash', parentId: null });
  api.db.share(app.id, 'hash');
  const page = await (await api.get(`/a/${app.id}`)).text();
  assert.doesNotMatch(page, /<script>alert|<img src=x/);
  assert.match(page, /&lt;\/title&gt;&lt;script&gt;alert\(&quot;x&quot;\)/);
  assert.match(page, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;&amp;/);
  assert.match(page, new RegExp(`property="og:url" content="https://blink.example/a/${app.id}"`));
  assert.match(page, /property="og:image" content="https:\/\/blink.example\/og.png"/);
  assert.match(page, /name="twitter:card" content="summary_large_image"/);
  assert.match(page, /name="twitter:image" content="https:\/\/blink.example\/og.png"/);
  assert.match(page, new RegExp(`<iframe[^>]*sandbox="allow-scripts"[^>]*src="/raw/${app.id}"`));
  assert.match(page, /href="\/">Make your own/);
  assert.match(page, new RegExp(`href="/\\?remix=${app.id}">Remix this`));
  assert.match(page, /<button[^>]*>Report<\/button>/);
  assert.ok(page.includes(`/api/apps/${app.id}/report`));
  assert.match(page, /method:\s*['"]POST['"]/);
  assert.match(page, /application\/json/);
  const response = await api.post('/api/generate', { prompt: 'clock' }, undefined, { Origin: 'https://blink.example' });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal((await (await api.get('/api/config')).json()).publicOrigin, 'https://blink.example');
});

test('gallery pages newest shared apps without timestamp gaps, private apps, or hidden apps', async t => {
  const api = setup(t);
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const app = api.db.save({ title: `${i}`, prompt: `${i}`, html: HTML, ipHash: 'hash', parentId: null });
    ids.push(app.id);
    if (i !== 0) api.db.share(app.id, 'hash');
  }
  api.db.hide(ids[4]);
  const first = await (await api.get('/api/gallery?limit=2')).json();
  assert.deepEqual(first.items.map((a: any) => a.id), [ids[5], ids[3]]);
  assert.deepEqual(Object.keys(first.items[0]).sort(), ['id', 'title', 'prompt', 'createdAt'].sort());
  const second = await (await api.get(`/api/gallery?limit=2&cursor=${first.nextCursor}`)).json();
  assert.deepEqual(second.items.map((a: any) => a.id), [ids[2], ids[1]]);
  assert.equal(second.nextCursor, null);
  for (const query of ['limit=0', 'limit=1.5', 'limit=abc', 'cursor=bad']) {
    assert.equal((await api.get(`/api/gallery?${query}`)).status, 400);
  }
});

test('reports deduplicate clients, three reporters hide gallery/share page, and admin hide requires token', async t => {
  const api = setup(t, { ADMIN_TOKEN: 'admin-secret' });
  const id = (await api.generate()).find(e => e.type === 'done').appId;
  await api.post(`/api/apps/${id}/share`);
  for (const ip of ['203.0.113.2', '203.0.113.2', '203.0.113.3']) {
    assert.deepEqual(await (await api.post(`/api/apps/${id}/report`, {}, ip)).json(), { ok: true });
  }
  assert.equal((await (await api.get('/api/gallery')).json()).items.length, 1);
  await api.post(`/api/apps/${id}/report`, {}, '203.0.113.4');
  assert.equal((await (await api.get('/api/gallery')).json()).items.length, 0);
  assert.equal((await api.get(`/a/${id}`)).status, 404);
  const next = (await api.generate()).find(e => e.type === 'done').appId;
  await api.post(`/api/apps/${next}/share`);
  for (const auth of ['', 'Bearer wrong', 'Bearer admin-secrex', 'Basic admin-secret']) {
    assert.equal((await api.post(`/api/admin/apps/${next}/hide`, {}, undefined, { Authorization: auth })).status, 401);
  }
  assert.deepEqual(await (await api.post(`/api/admin/apps/${next}/hide`, {}, undefined, { Authorization: 'Bearer admin-secret' })).json(), { ok: true });
  assert.equal((await api.get(`/a/${next}`)).status, 404);
  const disabled = setup(t);
  assert.equal((await disabled.post(`/api/admin/apps/${next}/hide`, {}, undefined, { Authorization: 'Bearer whatever' })).status, 404);
});

test('remixes load saved HTML on the server, record parentId, and reject untrusted or inaccessible HTML', async t => {
  const requests: any[] = [];
  const api = setup(t, {}, async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    requests.push(JSON.parse(text));
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: HTML } }] })}\n\ndata: [DONE]\n\n`);
  });
  const id = (await api.generate()).find(e => e.type === 'done').appId;
  const remix = (await api.generate({ prompt: 'make it blue', remixOf: id })).find(e => e.type === 'done');
  assert.equal(api.db.get(remix.appId)?.parentId, id);
  assert.ok(requests[1].messages[0].content.includes(`Here is the current app:\n${HTML}\n\nChange it: make it blue`));
  assert.equal((await api.post('/api/generate', { prompt: 'x', remixOf: 'unknown' })).status, 400);
  assert.equal((await api.post('/api/generate', { prompt: 'x', remixOf: id }, '203.0.113.2')).status, 400);
  assert.equal((await api.post('/api/generate', { prompt: 'x', currentHtml: HTML })).status, 400);
  await api.post(`/api/apps/${id}/share`);
  assert.ok((await api.generate({ prompt: 'blue', remixOf: id }, '203.0.113.2')).some(e => e.appId));
  const big = api.db.save({ title: 'big', prompt: 'x', html: '<html>' + '🌟'.repeat(50_000) + '</html>', ipHash: api.db.get(id)!.ipHash, parentId: null });
  assert.equal((await api.post('/api/generate', { prompt: 'x', remixOf: big.id })).status, 400);
});

for (const failure of ['429', '503', 'network', 'body-network'] as const) {
  test(`retries ${failure} once before first token`, async t => {
    let calls = 0;
    const api = setup(t, {}, (req, res) => {
      calls++;
      if (calls === 1) {
        if (failure === 'network') return req.socket.destroy();
        if (failure === 'body-network') { res.writeHead(200); res.flushHeaders(); return req.socket.destroy(); }
        res.writeHead(Number(failure));
        return res.end('secret');
      }
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: HTML } }] })}\n\ndata: [DONE]\n\n`);
    });
    const stream = await api.generate();
    assert.equal(calls, 2);
    assert.equal(stream.filter(e => e.type === 'done').length, 1);
    assert.equal(stream.filter(e => e.type === 'error').length, 0);
  });
}

test('does not retry a network failure after the first token or persist a partial result', async t => {
  let calls = 0;
  const api = setup(t, {}, (req, res) => {
    calls++;
    res.write('data: {"choices":[{"delta":{"content":"<html>partial"}}]}\n\n');
    setTimeout(() => req.socket.destroy(), 5);
  });
  const stream = await api.generate();
  assert.equal(calls, 1);
  assert.ok(stream.some(e => e.type === 'delta'));
  assert.ok(stream.some(e => e.type === 'error' && e.retryable === true));
  assert.ok(!stream.some(e => e.type === 'done'));
});

test('persistent upstream rate errors are safe, friendly and end every variant', async t => {
  let calls = 0;
  const api = setup(t, {}, (_req, res) => { calls++; res.writeHead(429); res.end('token-secret'); });
  const stream = await api.generate();
  assert.equal(calls, 2);
  const error = stream.find(e => e.type === 'error');
  assert.equal(error.retryable, true);
  assert.match(error.message, /paused|busy|try again/i);
  assert.doesNotMatch(JSON.stringify(stream), /token-secret/);
  assert.deepEqual(stream.at(-1), { type: 'end' });
});

test('race accepts both matching single-variant lanes while rejecting other overlapping runs', async t => {
  const gate = deferred();
  const api = setup(t, {
    COMPARE_BASE_URL: 'http://blink-test-1/v1', COMPARE_API_KEY: 'secret', COMPARE_MODEL: 'model', COMPARE_LABEL: 'GPU',
  }, async (_req, res) => { await gate.promise; res.end('data: [DONE]\n\n'); });
  assert.equal((await api.post('/api/generate', { prompt: 'a clock', lane: 'compare', variants: 4 })).status, 400);
  const first = await api.post('/api/generate', { prompt: 'a clock', lane: 'cerebras' });
  const second = await api.post('/api/generate', { prompt: 'a clock', lane: 'compare', variants: 1 });
  assert.equal(second.status, 200);
  assert.equal((await api.post('/api/generate', { prompt: 'a clock', lane: 'compare' })).status, 429);
  assert.equal((await api.post('/api/generate', { prompt: 'a different clock', lane: 'cerebras' })).status, 429);
  gate.resolve();
  for (const response of [first, second]) {
    const stream = events(await response.text());
    assert.equal(stream.find(e => e.type === 'done').variant, 0);
    assert.deepEqual(stream.at(-1), { type: 'end' });
  }
});

test('x4 failures remain isolated and end follows all variants', async t => {
  let calls = 0;
  const api = setup(t, {}, (req, res) => {
    calls++;
    if (calls === 1) { res.writeHead(401); return res.end('provider-secret'); }
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: HTML } }] })}\n\ndata: [DONE]\n\n`);
  });
  const stream = await api.generate({ prompt: 'x', variants: 4 });
  assert.equal(calls, 4, 'non-retryable 401 must not be retried');
  assert.equal(stream.filter(e => e.type === 'done').length, 3);
  const error = stream.find(e => e.type === 'error');
  assert.equal(error.variant, 0);
  assert.equal(error.retryable, false);
  assert.match(error.message, /paused/i);
  assert.deepEqual(stream.at(-1), { type: 'end' });
});

test('queued disconnects cancel work, restore capacity, and update the next client position', async t => {
  const gate = deferred();
  let calls = 0;
  const api = setup(t, { MAX_CONCURRENT: '1', MAX_QUEUE: '2' }, async (_req, res) => {
    calls++;
    await gate.promise;
    res.end('data: [DONE]\n\n');
  });
  const active = await api.post('/api/generate', { prompt: 'active' });
  const controller = new AbortController();
  const cancelled = await fetch(`${api.url}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.2' },
    body: JSON.stringify({ prompt: 'cancel' }), signal: controller.signal,
  });
  const next = await api.post('/api/generate', { prompt: 'next' }, '203.0.113.3');
  const nextReader = next.body!.getReader();
  const decoder = new TextDecoder();
  let text = decoder.decode((await nextReader.read()).value);
  assert.ok(text.includes('"position":2'));
  controller.abort();
  await assert.rejects(cancelled.text());
  while (!text.includes('"position":1')) text += decoder.decode((await nextReader.read()).value);
  gate.resolve();
  await active.text();
  for (;;) {
    const chunk = await nextReader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  assert.equal(calls, 2);
  assert.deepEqual(events(text).filter(e => e.type === 'queue').map(e => e.position), [2, 1, 0]);
});

test('server-wide slot limit bounds simultaneous x4 upstream calls across clients', async t => {
  const gate = deferred();
  const eightStarted = deferred();
  let calls = 0;
  let active = 0;
  let peak = 0;
  const api = setup(t, {}, async (_req, res) => {
    calls++;
    peak = Math.max(peak, ++active);
    if (calls === 8) eightStarted.resolve();
    await gate.promise;
    active--;
    res.end('data: [DONE]\n\n');
  });
  const first = await api.post('/api/generate', { prompt: 'x', variants: 4 });
  const second = await api.post('/api/generate', { prompt: 'y', variants: 4 }, '203.0.113.2');
  await eightStarted.promise;
  const third = await api.post('/api/generate', { prompt: 'z' }, '203.0.113.3');
  assert.equal(calls, 8);
  gate.resolve();
  await Promise.all([first.text(), second.text(), third.text()]);
  assert.equal(calls, 9);
  assert.equal(peak, 8);
});

test('disconnects keep occupied slots until their aborted upstream operations settle', async t => {
  const api = setup(t, { MAX_CONCURRENT: '1' });
  const aborted = deferred();
  const settle = deferred();
  let calls = 0;
  const transport = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
    if (!url.startsWith('http://blink-test-1/')) return transport(url, init);
    if (++calls > 1) return new Response('data: [DONE]\n\n');
    init.signal!.addEventListener('abort', () => aborted.resolve(), { once: true });
    await settle.promise;
    throw new TypeError('Aborted transport');
  });
  const controller = new AbortController();
  const first = await fetch(`${api.url}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }), signal: controller.signal,
  });
  controller.abort();
  await aborted.promise;
  await assert.rejects(first.text());
  const next = await api.post('/api/generate', { prompt: 'y' }, '203.0.113.2');
  const text = next.text();
  assert.equal(calls, 1, 'aborting must finish before its slot is reused');
  settle.resolve();
  const stream = events(await text);
  assert.equal(calls, 2);
  assert.deepEqual(stream.filter(e => e.type === 'queue').map(e => e.position), [1, 0]);
});

test('/gallery and /gallery/ serve the same SPA document as home', async t => {
  const api = setup(t);
  const home = await api.get('/');
  const html = await home.text();
  for (const path of ['/gallery', '/gallery/', '/gallery?cursor=123']) {
    const response = await api.get(path);
    assert.equal(response.status, home.status);
    assert.equal(response.headers.get('content-type'), home.headers.get('content-type'));
    assert.equal(await response.text(), html);
  }
});

test('share metadata falls back to absolute request-origin URLs without public-origin configuration', async t => {
  const api = setup(t);
  const id = (await api.generate()).find(e => e.type === 'done').appId;
  await api.post(`/api/apps/${id}/share`);
  const page = await (await api.get(`/a/${id}`)).text();
  assert.ok(page.includes(`content="${api.url}/a/${id}"`));
  assert.ok(page.includes(`content="${api.url}/og.png"`));
});
