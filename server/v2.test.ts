import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  const cookies = new Map<string, string>();
  const cookie = (ip = '203.0.113.1') => cookies.get(ip)!;
  async function request(path: string, init: RequestInit, ip: string, extra: Record<string, string>) {
    const response = await fetch(`${url}${path}`, {
      ...init, headers: { 'CF-Connecting-IP': ip, ...(cookie(ip) ? { Cookie: cookie(ip) } : {}), ...extra },
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie && extra.Cookie === undefined) cookies.set(ip, setCookie.split(';')[0]);
    return response;
  }
  const post = (path: string, body: unknown = {}, ip = '203.0.113.1', extra: Record<string, string> = {}) => request(path, {
    method: 'POST', body: JSON.stringify(body),
  }, ip, { 'Content-Type': 'application/json', ...extra });
  const get = (path: string, ip = '203.0.113.1', extra: Record<string, string> = {}, method = 'GET') => request(path, { method }, ip, extra);
  async function generate(body: unknown = { prompt: 'a clock' }, ip?: string) {
    const response = await post('/api/generate', body, ip);
    assert.equal(response.status, 200);
    return events(await response.text());
  }
  return { env, db, url, post, get, generate, cookie };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('creator cookies are random, persistent, salted, HttpOnly, and secure on HTTPS', async t => {
  const api = setup(t, { BLINK_PUBLIC_ORIGIN: 'https://blink.example' });
  const first = await api.get('/api/config');
  const header = first.headers.get('set-cookie')!;
  assert.match(header, /^blink_creator=[A-Za-z0-9_-]{43};/);
  for (const flag of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=31536000', 'Secure']) assert.ok(header.includes(flag));
  const credential = api.cookie().split('=')[1];
  assert.equal(Buffer.from(credential, 'base64url').length, 32);
  assert.equal((await api.get('/missing')).headers.get('set-cookie'), null);
  for (const Cookie of ['', 'blink_creator=bad', `blink_creator=${'A'.repeat(42)}B`]) {
    const response = await api.get('/missing', undefined, { Cookie });
    assert.match(response.headers.get('set-cookie')!, /^blink_creator=[A-Za-z0-9_-]{43};/);
    assert.notEqual(response.headers.get('set-cookie')!.split(';')[0], api.cookie());
  }
  const id = (await api.generate()).find(e => e.type === 'done').appId;
  const app = api.db.get(id)!;
  assert.equal(app.creatorHash, createHash('sha256').update('test').update(credential).digest('hex'));
  assert.notEqual(app.creatorHash, credential);
  const http = setup(t);
  assert.doesNotMatch((await http.get('/api/config')).headers.get('set-cookie')!, /; Secure/);
});

test('ownership follows the browser across IPs and denies another browser on the same IP', async t => {
  const api = setup(t);
  const id = (await api.generate()).find(e => e.type === 'done').appId;
  const owner = { Cookie: api.cookie() };
  const stranger = { Cookie: `blink_creator=${randomBytes(32).toString('base64url')}` };
  for (const path of [`/api/apps/${id}`, `/raw/${id}`]) {
    assert.equal((await api.get(path, undefined, stranger)).status, 404);
    assert.equal((await api.get(path, '198.51.100.1', owner)).status, 200);
  }
  assert.equal((await api.post(`/api/apps/${id}/share`, {}, undefined, stranger)).status, 403);
  assert.equal((await api.post('/api/generate', { prompt: 'blue', remixOf: id }, undefined, stranger)).status, 400);
  const remix = await api.post('/api/generate', { prompt: 'blue', remixOf: id }, '198.51.100.1', owner);
  assert.equal(remix.status, 200);
  assert.ok(events(await remix.text()).some(e => e.type === 'done'));
  assert.equal((await api.post(`/api/apps/${id}/share`, {}, '198.51.100.2', owner)).status, 200);
});

test('metadata only discloses shared, visible parents, including to the child creator', async t => {
  const api = setup(t);
  const parent = (await api.generate()).find(e => e.type === 'done').appId;
  const child = (await api.generate({ prompt: 'blue', remixOf: parent })).find(e => e.type === 'done').appId;
  await api.post(`/api/apps/${child}/share`);
  for (const ip of ['203.0.113.1', '203.0.113.2']) {
    assert.equal((await (await api.get(`/api/apps/${child}`, ip)).json()).parentId, null);
  }
  await api.post(`/api/apps/${parent}/share`);
  assert.equal((await (await api.get(`/api/apps/${child}`, '203.0.113.2')).json()).parentId, parent);
  api.db.hide(parent);
  assert.equal((await (await api.get(`/api/apps/${child}`)).json()).parentId, null);
});

test('GET and HEAD share/raw responses have the same isolation headers and HEAD has no body', async t => {
  const api = setup(t);
  const id = (await api.generate()).find(e => e.type === 'done').appId;
  await api.post(`/api/apps/${id}/share`);
  for (const path of [`/a/${id}`, `/raw/${id}`, '/raw/unknown', '/raw/abcdefghij']) {
    const get = await api.get(path);
    const head = await api.get(path, undefined, {}, 'HEAD');
    assert.equal(head.status, get.status);
    for (const header of ['content-type', 'content-security-policy', 'x-content-type-options', 'cache-control']) {
      assert.equal(head.headers.get(header), get.headers.get(header));
    }
    assert.equal(await head.text(), '');
    if (path.startsWith('/raw/')) assert.equal(get.headers.get('content-security-policy'), CSP);
  }
});

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
  const stream = await api.generate({ prompt: 'a clock', variants: 4, conversationId: 'browser-run' });
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map(r => r.user).sort(), ['browser-run:v0', 'browser-run:v1', 'browser-run:v2', 'browser-run:v3']);
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
  const app = api.db.save({ title: evil, prompt: '\"><img src=x onerror=alert(1)>&', html: HTML, ipHash: 'hash', creatorHash: 'hash', parentId: null });
  api.db.share(app.id, 'hash');
  const page = await (await api.get(`/a/${app.id}`)).text();
  assert.doesNotMatch(page, /Cerebras|Kimi/);
  assert.doesNotMatch(page, /<script>alert|<img src=x/);
  assert.match(page, /&lt;\/title&gt;&lt;script&gt;alert\(&quot;x&quot;\)/);
  assert.match(page, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;&amp;/);
  assert.match(page, new RegExp(`property="og:url" content="https://blink.example/a/${app.id}"`));
  assert.match(page, /property="og:image" content="https:\/\/blink.example\/og.png"/);
  assert.match(page, /name="twitter:card" content="summary_large_image"/);
  assert.match(page, /name="twitter:image" content="https:\/\/blink.example\/og.png"/);
  const iframe = page.match(/<iframe[^>]*>/)![0];
  assert.ok(iframe.includes(`src="/raw/${app.id}"`));
  assert.doesNotMatch(iframe, /\bsandbox\s*=/);
  assert.match(iframe, /referrerpolicy="no-referrer"/);
  assert.match(iframe, /allow=""/);
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
    const app = api.db.save({ title: `${i}`, prompt: `${i}`, html: HTML, ipHash: 'hash', creatorHash: 'hash', parentId: null });
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
  const big = api.db.save({ title: 'big', prompt: 'x', html: '<html>' + '🌟'.repeat(50_000) + '</html>', ipHash: api.db.get(id)!.ipHash, creatorHash: api.db.get(id)!.creatorHash, parentId: null });
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
        res.writeHead(Number(failure), { 'Retry-After': '0' });
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
  assert.deepEqual(stream.find(e => e.type === 'error'), {
    type: 'error', variant: 0, retryable: true,
    message: 'That app came out too long. Try a simpler idea, or build it up with remixes.',
  });
  assert.ok(!stream.some(e => e.type === 'done'));
});

for (const ending of ['error', 'eof', 'length'] as const) {
  test(`a streamed ${ending} failure ends every variant with the too-long message and no automatic retry`, async t => {
    let calls = 0;
    const api = setup(t, {}, (_req, res) => {
      calls++;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: HTML } }] })}\n\n`);
      res.end(ending === 'error' ? 'data: {"error":{"message":"internal secret"}}\n\n'
        : ending === 'length' ? 'data: {"choices":[{"finish_reason":"length"}]}\n\ndata: [DONE]\n\n' : '');
    });
    const stream = await api.generate({ prompt: 'clock', variants: 4 });
    assert.equal(calls, 4);
    assert.deepEqual(stream.filter(e => e.type === 'error').sort((a, b) => a.variant - b.variant), Array.from({ length: 4 }, (_, variant) => ({
      type: 'error', variant, retryable: true,
      message: 'That app came out too long. Try a simpler idea, or build it up with remixes.',
    })));
    assert.ok(!stream.some(e => e.type === 'done'));
    const observer = new DatabaseSync(join(api.env.BLINK_DATA_DIR, 'blink.db'));
    try { assert.equal(observer.prepare('SELECT COUNT(*) AS count FROM apps').get()!.count, 0); }
    finally { observer.close(); }
    assert.deepEqual(stream.at(-1), { type: 'end' });
  });
}

for (const format of ['stream', 'response'] as const) {
  test(`${format} reconciles a completion above 7000 tokens to actual prompt plus output usage`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    let calls = 0;
    const api = setup(t, { TOKENS_PER_MIN: '25000' }, async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const includeUsage = JSON.parse(body).stream_options?.include_usage === true;
      calls++;
      const usage = { prompt_tokens: 3789, completion_tokens: 8000 };
      if (format === 'response') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: HTML } }], usage }));
      } else res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: HTML } }], ...(includeUsage ? { usage } : {}) })}\n\ndata: [DONE]\n\n`);
    });
    for (let i = 0; i < 2; i++) {
      const stream = await api.generate();
      assert.equal(stream.find(e => e.type === 'done')?.stats.outputTokens, 8000);
    }
    // 2 * 11789 actual tokens + a new reservation exceeds 25000. The second
    // attempt fits only after the first reservation is reconciled downwards.
    const third = await api.post('/api/generate', { prompt: 'third' });
    await new Promise(setImmediate);
    assert.equal(calls, 2);
    t.mock.timers.tick(59_999);
    await new Promise(setImmediate);
    assert.equal(calls, 2);
    t.mock.timers.tick(1);
    assert.ok(events(await third.text()).some(e => e.type === 'done'));
    assert.equal(calls, 3);
  });
}

test('twelve large completions wait rather than exceed TOKENS_PER_MIN within a minute', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const starts: number[] = [];
  const api = setup(t, { TOKENS_PER_MIN: '90000' }, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const includeUsage = JSON.parse(body).stream_options?.include_usage === true;
    starts.push(Date.now());
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: HTML } }], ...(includeUsage ? { usage: { prompt_tokens: 4000, completion_tokens: 9000 } } : {}) })}\n\ndata: [DONE]\n\n`);
  });
  for (let i = 0; i < 6; i++) await api.generate();
  const remaining = [];
  for (let i = 0; i < 6; i++) remaining.push(await api.post('/api/generate', { prompt: 'clock' }, `203.0.113.${i + 2}`));
  await new Promise(setImmediate);
  assert.equal(starts.length, 6);
  t.mock.timers.tick(59_999);
  await new Promise(setImmediate);
  assert.equal(starts.length, 6);
  t.mock.timers.tick(1);
  for (const response of remaining) {
    const stream = events(await response.text());
    assert.ok(stream.some(e => e.type === 'queue' && e.position > 0));
    assert.ok(stream.some(e => e.type === 'done'));
  }
  assert.equal(starts.length, 12);
  for (const start of starts) assert.ok(starts.filter(at => at >= start && at < start + 60_000).length * 13_000 <= 90_000);
});

test('persistent upstream rate errors are safe, friendly and end every variant', async t => {
  let calls = 0;
  const api = setup(t, {}, (_req, res) => { calls++; res.writeHead(429, { 'Retry-After': '0' }); res.end('token-secret'); });
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
  const api = setup(t, { TOKENS_PER_MIN: '200000' }, async (_req, res) => {
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

test('race runId pairs lanes with different remix parents and rejects other run IDs', async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  let block = false;
  const api = setup(t, {
    COMPARE_BASE_URL: 'http://blink-test-1/v1', COMPARE_API_KEY: 'secret', COMPARE_MODEL: 'model', COMPARE_LABEL: 'GPU',
  }, async (_req, res) => {
    if (block) await gate.promise;
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: HTML } }] })}\n\ndata: [DONE]\n\n`);
  });
  const parentA = (await api.generate()).find(e => e.type === 'done').appId;
  const parentB = (await api.generate()).find(e => e.type === 'done').appId;
  block = true;
  const first = await api.post('/api/generate', { prompt: 'blue', lane: 'cerebras', remixOf: parentA, runId: 'race_1' });
  assert.equal(first.status, 200);
  const other = await api.post('/api/generate', { prompt: 'blue', lane: 'compare', remixOf: parentA, runId: 'race_2' });
  assert.equal(other.status, 429);
  const second = await api.post('/api/generate', { prompt: 'blue', lane: 'compare', remixOf: parentB, runId: 'race_1' });
  assert.equal(second.status, 200);
  assert.equal((await api.post('/api/generate', { prompt: 'blue', lane: 'compare', runId: 'race_1' })).status, 429);
  gate.resolve();
  for (const [response, parent] of [[first, parentA], [second, parentB]] as const) {
    const id = events(await response.text()).find(e => e.type === 'done').appId;
    assert.equal(api.db.get(id)?.parentId, parent);
  }
  for (const runId of ['', 'x'.repeat(65), 'with space', 'with:colon', 7, null, 'line\nbreak']) {
    assert.equal((await api.post('/api/generate', { prompt: 'x', runId })).status, 400);
  }
  assert.ok((await api.generate({ prompt: 'x', runId: 'A-_9'.repeat(16) })).some(e => e.type === 'done'));
});

test('global job admission is independent of identity and IPv6 rotation shares hourly limits', async t => {
  const api = setup(t, { GLOBAL_JOBS_PER_MIN: '2', HOURLY_LIMIT: '1' });
  await api.generate({ prompt: 'one' }, '2001:db8:1:2::1');
  const rotated = await api.post('/api/generate', { prompt: 'two' }, '2001:db8:1:2::2');
  assert.equal(rotated.status, 429);
  await api.generate({ prompt: 'three' }, '2001:db8:1:3::1');
  const aggregate = await api.post('/api/generate', { prompt: 'four' }, '198.51.100.1');
  assert.equal(aggregate.status, 429);
  assert.ok(Number(aggregate.headers.get('retry-after')) > 0);
});

test('report hiding counts distinct normalized networks and ignores private or already hidden apps', async t => {
  const api = setup(t);
  const id = (await api.generate()).find(e => e.type === 'done').appId;
  const observer = new DatabaseSync(join(api.env.BLINK_DATA_DIR, 'blink.db'));
  t.after(() => observer.close());
  const before = observer.prepare('PRAGMA data_version').get();
  assert.deepEqual(await (await api.post(`/api/apps/${id}/report`)).json(), { ok: true });
  assert.deepEqual(observer.prepare('PRAGMA data_version').get(), before);
  await api.post(`/api/apps/${id}/share`);
  for (const ip of ['2001:db8:1:2::1', '2001:0db8:1:2:ffff::2', '2001:db8:1:2::3', '::ffff:203.0.113.8', '203.0.113.8']) {
    assert.deepEqual(await (await api.post(`/api/apps/${id}/report`, {}, ip)).json(), { ok: true });
  }
  assert.equal(api.db.get(id)?.hidden, false);
  assert.equal(observer.prepare('SELECT COUNT(*) AS n FROM reports').get()!.n, 2);
  await api.post(`/api/apps/${id}/report`, {}, '2001:db8:1:3::1');
  assert.equal(api.db.get(id)?.hidden, true);
  const hiddenVersion = observer.prepare('PRAGMA data_version').get();
  assert.deepEqual(await (await api.post(`/api/apps/${id}/report`, {}, '198.51.100.1')).json(), { ok: true });
  assert.deepEqual(observer.prepare('PRAGMA data_version').get(), hiddenVersion);
});

test('report write limit is checked before SQLite and shares the normalized abuse key', async t => {
  const api = setup(t, { REPORTS_PER_HOUR: '2' });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = (await api.generate()).find(e => e.type === 'done').appId;
    await api.post(`/api/apps/${id}/share`);
    ids.push(id);
  }
  for (const [i, ip] of ['2001:db8:1:2::1', '2001:db8:1:2::2'].entries()) {
    assert.equal((await api.post(`/api/apps/${ids[i]}/report`, {}, ip)).status, 200);
  }
  const get = t.mock.method(AppDatabase.prototype, 'get', () => { throw new Error('Rate-limited reports must not touch SQLite'); });
  const limited = await api.post(`/api/apps/${ids[2]}/report`, {}, '2001:db8:1:2::3');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 3500);
  assert.equal((await limited.json()).error, 'rate_limited');
  get.mock.restore();
  assert.equal((await api.post(`/api/apps/${ids[2]}/report`, {}, '2001:db8:1:3::1')).status, 200);
});

for (const limit of [{ REQUESTS_PER_MIN: '2' }, { TOKENS_PER_MIN: '26100' }]) {
  test(`x4 attempts wait in the queue for the shared ${Object.keys(limit)[0]} budget`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    let calls = 0;
    const api = setup(t, limit, (_req, res) => {
      calls++;
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: HTML } }] })}\n\ndata: [DONE]\n\n`);
    });
    const response = await api.post('/api/generate', { prompt: 'clock', variants: 4 });
    await new Promise(setImmediate);
    assert.equal(calls, 2);
    t.mock.timers.tick(59_999);
    await new Promise(setImmediate);
    assert.equal(calls, 2);
    t.mock.timers.tick(1);
    const stream = events(await response.text());
    assert.equal(calls, 4);
    assert.equal(stream.filter(e => e.type === 'done').length, 4);
    assert.ok(stream.some(e => e.type === 'queue' && e.position > 0));
    assert.ok(stream.some(e => e.type === 'queue' && e.position === 0));
    assert.equal(stream.filter(e => e.type === 'status').length, 4);
  });
}

for (const limit of [{ REQUESTS_PER_MIN: '1' }, { TOKENS_PER_MIN: '14000' }]) {
  test(`retries consume the same ${Object.keys(limit)[0]} budget as new attempts`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    let calls = 0;
    const api = setup(t, limit, (_req, res) => {
      if (++calls === 1) { res.writeHead(503); return res.end(); }
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: HTML } }] })}\n\ndata: [DONE]\n\n`);
    });
    const response = await api.post('/api/generate', { prompt: 'clock' });
    await new Promise(setImmediate);
    assert.equal(calls, 1);
    t.mock.timers.tick(59_999);
    await new Promise(setImmediate);
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    const stream = events(await response.text());
    assert.equal(calls, 2);
    assert.equal(stream.filter(e => e.type === 'done').length, 1);
    assert.ok(stream.some(e => e.type === 'queue' && e.position > 0));
  });
}

for (const retryAfter of [undefined, '5', 'Thu, 01 Jan 1970 00:00:07 GMT', '400']) {
  test(`upstream 429 pauses new jobs and its retry for Retry-After ${retryAfter}`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    let calls = 0;
    const api = setup(t, {}, (_req, res) => {
      if (++calls === 1) {
        res.writeHead(429, retryAfter === undefined ? {} : { 'Retry-After': retryAfter });
        return res.end('secret');
      }
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: HTML } }] })}\n\ndata: [DONE]\n\n`);
    });
    const first = await api.post('/api/generate', { prompt: 'first' });
    await new Promise(setImmediate);
    const second = await api.post('/api/generate', { prompt: 'second' }, '203.0.113.2');
    await new Promise(setImmediate);
    assert.equal(calls, 1);
    const delay = retryAfter === undefined ? 20_000 : retryAfter.includes('GMT') ? 7000 : Number(retryAfter) * 1000;
    t.mock.timers.tick(delay - 1);
    await new Promise(setImmediate);
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    for (const response of [first, second]) {
      const stream = events(await response.text());
      assert.ok(stream.some(e => e.type === 'queue' && e.position > 0));
      assert.equal(stream.filter(e => e.type === 'done').length, 1);
      assert.equal(stream.filter(e => e.type === 'error').length, 0);
    }
    assert.equal(calls, 3);
  });
}

test('upstream admission budget is shared across clients and race lanes', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let calls = 0;
  const api = setup(t, {
    REQUESTS_PER_MIN: '1', COMPARE_BASE_URL: 'http://blink-test-1/v1',
    COMPARE_API_KEY: 'secret', COMPARE_MODEL: 'model', COMPARE_LABEL: 'GPU',
  }, (_req, res) => { calls++; res.end('data: [DONE]\n\n'); });
  await api.generate({ prompt: 'one', lane: 'cerebras' });
  const next = await api.post('/api/generate', { prompt: 'two', lane: 'compare' }, '203.0.113.2');
  const reader = next.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('"position":1')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    text += decoder.decode(chunk.value);
  }
  assert.equal(calls, 1);
  t.mock.timers.tick(60_000);
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  const stream = events(text);
  assert.equal(calls, 2);
  assert.deepEqual(stream.filter(e => e.type === 'queue').map(e => e.position), [0, 1, 0]);
});

test('disconnecting during quota wait cancels the attempt and leaves budget for the next job', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let calls = 0;
  const api = setup(t, { REQUESTS_PER_MIN: '1', MAX_CONCURRENT: '1' }, (_req, res) => {
    calls++;
    res.end('data: [DONE]\n\n');
  });
  await api.generate();
  const controller = new AbortController();
  const cancelled = await fetch(`${api.url}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.2' },
    body: JSON.stringify({ prompt: 'cancel' }), signal: controller.signal,
  });
  await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(cancelled.text());
  const next = await api.post('/api/generate', { prompt: 'next' }, '203.0.113.3');
  t.mock.timers.tick(60_000);
  assert.ok(events(await next.text()).some(e => e.type === 'done'));
  assert.equal(calls, 2);
});

test('default report limit permits ten writes per normalized identity and resets after an hour', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const api = setup(t);
  const id = (await api.generate()).find(e => e.type === 'done').appId;
  for (let i = 0; i < 11; i++) assert.equal((await api.post(`/api/apps/${id}/report`)).status, 200);
  await api.post(`/api/apps/${id}/share`);
  for (let i = 0; i < 10; i++) assert.equal((await api.post(`/api/apps/${id}/report`)).status, 200);
  assert.equal((await api.post(`/api/apps/${id}/report`)).status, 429);
  t.mock.timers.tick(3_599_999);
  assert.equal((await api.post(`/api/apps/${id}/report`)).status, 429);
  t.mock.timers.tick(1);
  assert.equal((await api.post(`/api/apps/${id}/report`)).status, 200);
});

for (const lane of ['cerebras', 'compare'] as const) {
  test(`${lane} charges real prompt usage above the reservation before admitting another attempt`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    let calls = 0;
    const api = setup(t, {
      TOKENS_PER_MIN: '70000', COMPARE_BASE_URL: 'http://blink-test-1/v1',
      COMPARE_API_KEY: 'secret', COMPARE_MODEL: 'model', COMPARE_LABEL: 'GPU',
    }, async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      calls++;
      const usage = JSON.parse(body).stream_options?.include_usage === true
        ? { prompt_tokens: 60000, completion_tokens: 100 } : undefined;
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: HTML } }], usage })}\n\ndata: [DONE]\n\n`);
    });
    await api.generate({ prompt: 'first', lane });
    const next = await api.post('/api/generate', { prompt: 'next', lane });
    await new Promise(setImmediate);
    assert.equal(calls, 1);
    t.mock.timers.tick(59_999);
    await new Promise(setImmediate);
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    assert.ok(events(await next.text()).some(e => e.type === 'done'));
    assert.equal(calls, 2);
  });
}

test('remixes preserve conversation IDs below eight parent levels and start fresh at the cap', async t => {
  const requests: any[] = [];
  const api = setup(t, { TOKENS_PER_MIN: '1000000' }, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: HTML } }] })}\n\ndata: [DONE]\n\n`);
  });
  let parent = (await api.generate({ prompt: 'clock', conversationId: 'chain' })).find(e => e.type === 'done').appId;
  for (let depth = 1; depth <= 9; depth++) {
    const done = (await api.generate({ prompt: 'blue', remixOf: parent, conversationId: 'chain' })).find(e => e.type === 'done');
    const request = requests.at(-1);
    if (depth < 8) assert.equal(request.user, 'chain');
    else {
      assert.notEqual(request.user, 'chain');
      assert.notEqual(request.user, requests.at(-2).user);
    }
    assert.ok(request.messages[0].content.includes(`Here is the current app:\n${HTML}\n\nChange it: blue`));
    assert.equal(api.db.get(done.appId)?.parentId, parent);
    parent = done.appId;
  }
});
