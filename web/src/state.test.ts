import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShareLinks, parseRemixQuery, createGeneration, reduceGeneration, generationStatus, createGallery, beginGalleryPage, finishGalleryPage, failGalleryPage } from './state.ts';
import { getApp, getRawHtml, getGallery, shareApp } from './api.ts';

const stats = { ttftMs: 42, totalMs: 1250, outputTokens: 900, tokensPerSecond: 800, tokensEstimated: true };

test('queue, waiting time, interleaved variants, errors and end reduce independently', () => {
  const initial = createGeneration(4);
  let state = reduceGeneration(initial, { type: 'queue', position: 3 }, 1000);
  assert.equal(generationStatus(state.variants[0], state.position, 2000), "You're #3 in line");
  state = reduceGeneration(state, { type: 'queue', position: 0 }, 2000);
  state = reduceGeneration(state, { type: 'status', variant: 2, phase: 'waiting_model' }, 3000);
  state = reduceGeneration(state, { type: 'status', variant: 2, phase: 'waiting_model' }, 4000);
  assert.equal(generationStatus(state.variants[2], 0, 26000), 'Waiting for the model · 23 s');
  state = reduceGeneration(state, { type: 'delta', variant: 2, text: 'third' }, 27000);
  state = reduceGeneration(state, { type: 'delta', variant: 0, text: 'first' }, 27000);
  state = reduceGeneration(state, { type: 'delta', variant: 2, text: ' app' }, 28000);
  state = reduceGeneration(state, { type: 'done', variant: 2, stats, appId: 'saved-third' }, 29000);
  state = reduceGeneration(state, { type: 'error', variant: 1, message: 'Paused', retryable: false }, 29000);
  assert.equal(state.variants[2].text, 'third app');
  assert.equal(state.variants[0].text, 'first');
  assert.equal(state.variants[2].appId, 'saved-third');
  assert.deepEqual(state.variants[2].stats, stats);
  assert.equal(state.variants[1].retryable, false);
  assert.equal(state.variants[1].error, 'Paused');
  assert.equal(state.ended, false);
  state = reduceGeneration(state, { type: 'end' }, 30000);
  assert.equal(state.ended, true);
  assert.equal(reduceGeneration(state, { type: 'delta', variant: 0, text: 'late' }, 31000), state);
  assert.equal(initial.variants[2].text, '');
});

test('share links use the current origin and encode the exact X text and app link', () => {
  const links = buildShareLinks('https://blink.example:5173', '/a/abc_123-XY');
  assert.equal(links.url, 'https://blink.example:5173/a/abc_123-XY');
  const intent = new URL(links.x);
  assert.equal(intent.pathname, '/intent/tweet');
  assert.equal(intent.searchParams.get('text'), 'I made this with one sentence on Blink ⚡');
  assert.equal(intent.searchParams.get('url'), links.url);
  for (const path of ['https://evil.test/a/id', '//evil.test/a/id', '/a/id?x=1', '/raw/id']) {
    assert.throws(() => buildShareLinks('https://blink.example', path));
  }
});

test('remix query parsing handles encoded IDs, absent and invalid values', () => {
  assert.equal(parseRemixQuery('?remix=abc%5F123-XY&from=gallery'), 'abc_123-XY');
  for (const query of ['', '?other=id', '?remix=', '?remix=../bad', '?remix=%3Cscript%3E']) assert.equal(parseRemixQuery(query), null);
});

const app = (id: string) => ({ id, title: id, prompt: 'An app', createdAt: 123 });

test('gallery appends unique pages, prevents concurrent/end loads and preserves cursor on failure', () => {
  const initial = createGallery();
  let state = beginGalleryPage(initial);
  assert.equal(beginGalleryPage(state), state);
  state = finishGalleryPage(state, { items: [app('a'), app('b')], nextCursor: '100' });
  state = failGalleryPage(beginGalleryPage(state), 'Offline');
  assert.equal(state.nextCursor, '100');
  assert.deepEqual(state.items.map(item => item.id), ['a', 'b']);
  assert.equal(state.loading, false);
  state = finishGalleryPage(beginGalleryPage(state), { items: [app('b'), app('c'), app('c')], nextCursor: null });
  assert.deepEqual(state.items.map(item => item.id), ['a', 'b', 'c']);
  assert.equal(beginGalleryPage(state), state);
  assert.equal(state.error, '');
  assert.deepEqual(initial.items, []);
});

test('saved app, raw HTML, sharing and gallery requests follow the contract with stubbed fetch', async t => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    requests.push(url);
    if (url.endsWith('/share')) {
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json');
      return Response.json({ url: '/a/saved' });
    }
    if (url.startsWith('/raw/')) return new Response('<html>Saved</html>');
    if (url.startsWith('/api/gallery')) return Response.json({ items: [app('saved')], nextCursor: '20' });
    return Response.json({ ...app('saved'), shared: true, parentId: null });
  });
  assert.equal((await getApp('saved')).id, 'saved');
  assert.equal(await getRawHtml('saved'), '<html>Saved</html>');
  assert.equal(await shareApp('saved'), '/a/saved');
  assert.equal((await getGallery('30 +')).nextCursor, '20');
  assert.deepEqual(requests, ['/api/apps/saved', '/raw/saved', '/api/apps/saved/share', '/api/gallery?limit=24&cursor=30+%2B']);
});
