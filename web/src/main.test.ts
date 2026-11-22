import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import type { GenerateEvent } from './api.ts';
import { extractHtml } from './extract.ts';
import { syncRaceLanes } from './lanes.ts';
import { buildPreviewDoc } from './preview.ts';
import * as state from './state.ts';
import { ApiError } from './api.ts';

// Exercise main's event handlers without a browser or a new DOM dependency.
class Element {
  children = new Map<string, Element>();
  handlers = new Map<string, (event: any) => any>();
  attributes = new Map<string, string>();
  parent: Element | null = null;
  hidden = false;
  checked = false;
  value = '';
  maxLength = 500;
  title = '';
  srcdoc = '';
  textContent = '';
  contentWindow = {};
  classList = { toggle() {}, add() {} };
  querySelector(selector: string): Element {
    if (!this.children.has(selector)) {
      const child = new Element();
      child.parent = this;
      if (selector === 'iframe') child.setAttribute('sandbox', 'allow-scripts');
      this.children.set(selector, child);
    }
    return this.children.get(selector)!;
  }
  querySelectorAll() { return []; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  append(child: Element) { child.parent = this; }
  addEventListener(type: string, handler: (event: any) => any) { this.handlers.set(type, handler); }
  replaceWith(next: Element) {
    const parent = this.parent;
    if (!parent) throw new Error('Cannot replace a detached element');
    for (const [key, child] of parent.children) {
      if (child === this) parent.children.set(key, next);
    }
    next.parent = parent;
    this.parent = null;
  }
  focus() {}
  select() {}
}

interface TestLane {
  iframe: Element;
  html: string;
  error: string;
  previewToken: string;
  conversationId: string;
  stats: unknown;
  appId: string | null;
  root: Element;
  phase: string;
}

const source = ts.transpileModule(
  readFileSync(new URL('./main.ts', import.meta.url), 'utf8').replace(/^import .*;\n/gm, ''),
  { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } },
).outputText;
const stats = { ttftMs: 10, totalMs: 100, outputTokens: 20, tokensPerSecond: 200, tokensEstimated: false };

function app(hidden = false, overrides: Record<string, unknown> = {}) {
  const document = Object.assign(new Element(), { hidden, createElement: () => new Element() });
  const timers = new Map<number, () => void>();
  const handlers = new Map<string, (event: any) => void>();
  const generations: { body: any; onEvent: (event: GenerateEvent) => void; resolve: () => void }[] = [];
  let nextTimer = 0;
  let nextId = 0;
  const context = createContext({
    ...state, ApiError, Date, location: { pathname: '/', search: '', origin: 'https://blink.test' }, history: { replaceState() {} },
    getGallery: async () => ({ items: [], nextCursor: null }),
    document, crypto: { randomUUID: () => `id-${++nextId}` }, performance, AbortController,
    requestAnimationFrame: () => 1, clearInterval() {}, extractHtml, syncRaceLanes, buildPreviewDoc,
    getConfig: async () => ({ compareEnabled: true, variantsEnabled: true, maxPromptChars: 500 }),
    generate: (body: unknown, onEvent: (event: GenerateEvent) => void) => new Promise<void>(resolve => {
      generations.push({ body, onEvent, resolve });
    }),
    window: {
      clearInterval() {},
      addEventListener: (type: string, handler: (event: any) => void) => handlers.set(type, handler),
      setTimeout: (callback: () => void, delay: number) => {
        assert.ok(delay === 6000 || delay === 4000);
        timers.set(++nextTimer, callback);
        return nextTimer;
      },
      clearTimeout: (id: number) => timers.delete(id), setInterval: () => 0,
    },
    ...overrides,
  });
  runInContext(source, context);
  const cerebras = runInContext('cerebras', context) as TestLane;
  const compare = runInContext('compare', context) as TestLane;
  return {
    document, timers, generations, cerebras, compare,
    run(code: string) { return runInContext(code, context); },
    variants: runInContext('variantLanes', context) as TestLane[],
    choose(index: number) { context.index = index; runInContext('chooseVariation(variantLanes[index])', context); },
    variations(checked: boolean) {
      document.querySelector('#variations').checked = checked;
      document.querySelector('#variations').handlers.get('change')!({});
    },
    preview(html: string) {
      context.html = html;
      runInContext('setPreview(cerebras, html)', context);
    },
    message(type: string, message?: string, token = cerebras.previewToken, source = cerebras.iframe.contentWindow) {
      handlers.get('message')!({ data: { blinkPreview: token, type, message }, source });
    },
    expire() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach(callback => callback());
    },
    visibility(hidden: boolean) {
      document.hidden = hidden;
      document.handlers.get('visibilitychange')!({});
    },
    start() {
      document.querySelector('#prompt').value = 'Build an app';
      return document.querySelector('#prompt-form').handlers.get('submit')!({ preventDefault() {} }) as Promise<void>;
    },
    race(checked: boolean) {
      document.querySelector('#race').checked = checked;
      document.querySelector('#race').handlers.get('change')!({});
    },
  };
}

test('each preview gets a fresh iframe with the sandbox and current title', () => {
  const ui = app();
  const original = ui.cerebras.iframe;
  original.title = 'Configured label app preview';
  ui.preview('<html>first</html>');
  const first = ui.cerebras.iframe;
  assert.notEqual(first, original);
  assert.equal(first.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(first.title, original.title);
  assert.equal(first.hidden, false);
  assert.ok(first.srcdoc.includes('<html>'));
  ui.preview('<html>second</html>');
  assert.notEqual(ui.cerebras.iframe, first);
  assert.equal(first.parent, null);
  assert.ok(ui.cerebras.iframe.srcdoc.includes('second'));
});

for (const changed of [false, true]) {
  test(`completion ${changed ? 'replaces a changed' : 'preserves an identical'} mid-stream preview`, async () => {
    const ui = app();
    const pending = ui.start();
    const generation = ui.generations[0];
    generation.onEvent({ type: 'delta', variant: 0, text: '<html><body>App</body></html>' });
    const iframe = ui.cerebras.iframe;
    const token = ui.cerebras.previewToken;
    if (changed) generation.onEvent({ type: 'delta', variant: 0, text: '<!-- final markup --></html>' });
    generation.onEvent({ type: 'done', variant: 0, stats, appId: 'saved-app' });
    generation.resolve();
    await pending;
    if (changed) assert.notEqual(ui.cerebras.iframe, iframe);
    else {
      assert.equal(ui.cerebras.iframe, iframe);
      assert.equal(ui.cerebras.previewToken, token);
    }
  });
}

test('late readiness clears a watchdog error and ignores old tokens and frames', () => {
  const ui = app();
  ui.preview('<html>App</html>');
  ui.expire();
  assert.match(ui.cerebras.error, /didn't render/);
  ui.message('ready', undefined, 'old-token');
  ui.message('ready', undefined, ui.cerebras.previewToken, {});
  assert.match(ui.cerebras.error, /didn't render/);
  ui.message('ready');
  assert.equal(ui.cerebras.error, '');
  ui.visibility(false);
  assert.equal(ui.timers.size, 0);
});

for (const afterWatchdog of [false, true]) {
  test(`readiness preserves runtime errors ${afterWatchdog ? 'after a watchdog timeout' : 'before a watchdog timeout'}`, () => {
    const ui = app();
    ui.preview('<html>App</html>');
    if (afterWatchdog) ui.expire();
    ui.message('error', 'startup failed');
    ui.message('ready');
    assert.equal(ui.cerebras.error, 'The app hit an error: startup failed');
    ui.expire();
    assert.equal(ui.cerebras.error, 'The app hit an error: startup failed');
  });
}

test('watchdog waits for visibility and restarts its six seconds after backgrounding', () => {
  const ui = app(true);
  ui.preview('<html>App</html>');
  assert.equal(ui.timers.size, 0);
  ui.visibility(false);
  assert.equal(ui.timers.size, 1);
  const queued = [...ui.timers.values()][0];
  ui.visibility(true);
  assert.equal(ui.timers.size, 0);
  queued(); // A timeout already queued when the tab became hidden must also be harmless.
  assert.equal(ui.cerebras.error, '');
  ui.visibility(false);
  assert.equal(ui.timers.size, 1);
  ui.expire();
  assert.match(ui.cerebras.error, /didn't render/);
});

test('Race toggles preserve completed comparison results until a solo remix changes the app', async () => {
  const ui = app();
  ui.race(true);
  const raceRun = ui.start();
  ui.generations.forEach((generation, index) => {
    generation.onEvent({ type: 'delta', variant: 0, text: `<html>Race result ${index}</html>` });
    generation.onEvent({ type: 'done', variant: 0, stats, appId: 'saved-app' });
    generation.resolve();
  });
  await raceRun;
  const { iframe, stats: comparisonStats, conversationId } = ui.compare;
  ui.race(false);
  ui.race(true);
  assert.equal(ui.compare.iframe, iframe);
  assert.equal(ui.compare.stats, comparisonStats);
  assert.equal(ui.compare.conversationId, conversationId);
  assert.equal(ui.compare.html, '<html>Race result 1</html>');
  ui.race(false);
  const soloRun = ui.start();
  const solo = ui.generations.at(-1)!;
  solo.onEvent({ type: 'delta', variant: 0, text: '<html>Newest solo remix</html>' });
  solo.onEvent({ type: 'done', variant: 0, stats, appId: 'saved-app' });
  solo.resolve();
  await soloRun;
  ui.race(true);
  assert.equal(ui.compare.html, '<html>Newest solo remix</html>');
  assert.notEqual(ui.compare.conversationId, conversationId);
  assert.equal(ui.compare.stats, null);
  const refreshed = ui.compare.iframe;
  ui.race(false);
  ui.race(true);
  assert.equal(ui.compare.iframe, refreshed);
});

test('four variations fan out into isolated previews and selection becomes the saved main app', async () => {
  const ui = app();
  assert.equal(ui.document.querySelector('#variations').checked, false);
  ui.variations(true);
  const pending = ui.start();
  assert.equal(ui.generations.length, 1);
  const generation = ui.generations[0];
  assert.equal(generation.body.variants, 4);
  generation.onEvent({ type: 'queue', position: 3 });
  for (const lane of ui.variants) assert.equal(lane.root.querySelector('.lane-status').textContent, "You're #3 in line");
  generation.onEvent({ type: 'queue', position: 0 });
  for (const index of [3, 0, 2, 1]) {
    generation.onEvent({ type: 'status', variant: index, phase: 'waiting_model' });
    assert.match(ui.variants[index].root.querySelector('.lane-status').textContent, /Waiting for Cerebras/);
    generation.onEvent({ type: 'delta', variant: index, text: `<html><body>Variation ${index}</body></html>` });
    generation.onEvent({ type: 'done', variant: index, stats, appId: `saved-${index}` });
  }
  generation.onEvent({ type: 'end' });
  generation.resolve();
  await pending;
  const tokens = new Set(ui.variants.map(lane => lane.previewToken));
  assert.equal(tokens.size, 4);
  for (const lane of ui.variants) {
    assert.equal(lane.iframe.getAttribute('sandbox'), 'allow-scripts');
    assert.ok(lane.iframe.srcdoc.includes('blinkPreview'));
  }
  ui.choose(2);
  assert.equal(ui.cerebras.appId, 'saved-2');
  assert.equal(ui.cerebras.html, '<html><body>Variation 2</body></html>');
  assert.deepEqual(ui.cerebras.stats, stats);
  assert.ok(ui.cerebras.iframe.srcdoc.includes('Variation 2'));
  assert.equal(ui.document.querySelector('#variations-grid').hidden, true);
  assert.equal((ui.cerebras.root.querySelector('.share') as any).disabled, false);
  const remix = ui.start();
  const next = ui.generations.at(-1)!;
  assert.equal(next.body.remixOf, 'saved-2');
  assert.equal('currentHtml' in next.body, false);
  assert.equal(next.body.variants, 1);
  next.onEvent({ type: 'error', variant: 0, message: 'Paused', retryable: false });
  next.onEvent({ type: 'end' });
  next.resolve();
  await remix;
  assert.equal(ui.cerebras.root.querySelector('.retry').hidden, true);
});

test('remix query loads raw HTML text into an instrumented fresh sandbox, then sends remixOf', async () => {
  const requests: string[] = [];
  const ui = app(false, {
    location: { pathname: '/', search: '?remix=shared-id', origin: 'https://blink.test' },
    getApp: async (id: string) => { requests.push(`/api/apps/${id}`); return { id }; },
    getRawHtml: async (id: string) => { requests.push(`/raw/${id}`); return '<html><head></head><body>Shared</body></html>'; },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, ['/api/apps/shared-id', '/raw/shared-id']);
  assert.equal(ui.cerebras.appId, 'shared-id');
  assert.ok(ui.cerebras.iframe.srcdoc.includes('blinkPreview'));
  assert.ok(ui.cerebras.iframe.srcdoc.includes('<body>Shared</body>'));
  assert.equal(ui.cerebras.iframe.getAttribute('src'), null);
  assert.equal(ui.cerebras.iframe.getAttribute('sandbox'), 'allow-scripts');
  const pending = ui.start();
  const generation = ui.generations[0];
  assert.equal(generation.body.remixOf, 'shared-id');
  assert.equal('currentHtml' in generation.body, false);
  generation.onEvent({ type: 'error', variant: 0, message: 'Please retry', retryable: true });
  generation.onEvent({ type: 'end' });
  generation.resolve();
  await pending;
  assert.equal(ui.cerebras.root.querySelector('.retry').hidden, false);
  // Retry uses the original parent even after the failed run cleared the lane ID.
  ui.cerebras.root.querySelector('.retry').handlers.get('click')!({});
  assert.equal(ui.generations[1].body.remixOf, 'shared-id');
  ui.generations[1].resolve();
});

test('sharing copies the full URL and exposes Post on X and Open', async () => {
  const copied: string[] = [];
  const shared: string[] = [];
  const ui = app(false, {
    shareApp: async (id: string) => { shared.push(id); return `/a/${id}`; },
    navigator: { clipboard: { writeText: async (text: string) => { copied.push(text); } } },
  });
  ui.cerebras.appId = 'my-app';
  await ui.run('shareLane(cerebras)');
  assert.deepEqual(shared, ['my-app']);
  assert.deepEqual(copied, ['https://blink.test/a/my-app']);
  assert.equal(ui.document.querySelector('#toast').textContent, 'Link copied');
  assert.equal(ui.cerebras.root.querySelector('.share-links').hidden, false);
  const root = ui.cerebras.root;
  assert.equal((root.querySelector('.open-share') as any).href, copied[0]);
  assert.equal(new URL((root.querySelector('.post-x') as any).href).searchParams.get('url'), copied[0]);
});

test('gallery cards create no frame until interaction and reuse the preview safety flow', async () => {
  let rawFetches = 0;
  const ui = app(false, {
    getRawHtml: async () => { rawFetches++; return '<html><body>Gallery app</body></html>'; },
  });
  const card = ui.run("galleryCard({ id: 'gallery-app', title: '<unsafe title>', prompt: '<unsafe prompt>', createdAt: 1 })") as Element;
  assert.equal(rawFetches, 0);
  assert.equal(card.querySelector('.gallery-preview').children.size, 0);
  assert.equal(card.querySelector('h3').textContent, '<unsafe title>');
  const button = card.querySelector('.preview-trigger');
  button.handlers.get('click')!({});
  button.handlers.get('pointerenter')!({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rawFetches, 1);
  const preview = ui.run('lanes.at(-1)') as TestLane;
  assert.equal(preview.iframe.getAttribute('sandbox'), 'allow-scripts');
  assert.ok(preview.iframe.srcdoc.includes('blinkPreview'));
  assert.ok(preview.iframe.srcdoc.includes('Gallery app'));
  assert.equal(button.hidden, true);
  ui.expire();
  assert.match(preview.error, /didn't render/);
});

test('gallery route shows the full gallery and hides the builder', () => {
  const ui = app(false, { location: { pathname: '/gallery', search: '', origin: 'https://blink.test' } });
  assert.equal(ui.document.querySelector('#builder').hidden, true);
  assert.equal(ui.document.querySelector('#gallery-link').hidden, true);
  assert.equal(ui.document.querySelector('#gallery-title').textContent, 'The Blink gallery');
});
