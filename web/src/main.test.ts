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
import { ApiError, generate } from './api.ts';

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
  innerHTML = '';
  className = '';
  contentWindow = {};
  focused = false;
  rect = { top: 0, bottom: 400 };
  scrolls: ScrollIntoViewOptions[] = [];
  classList = {
    contains: (name: string) => this.className.split(' ').includes(name),
    toggle: (name: string, force = !this.classList.contains(name)) => {
      const classes = new Set(this.className.split(' ').filter(Boolean));
      if (force) classes.add(name);
      else classes.delete(name);
      this.className = [...classes].join(' ');
      return force;
    },
    add: (name: string) => { this.classList.toggle(name, true); },
  };
  querySelector(selector: string): Element {
    if (!this.children.has(selector)) {
      const child = new Element();
      child.parent = this;
      if (selector === 'iframe') child.setAttribute('sandbox', 'allow-scripts');
      if (selector === '#variations') child.setAttribute('aria-pressed', 'false');
      this.children.set(selector, child);
    }
    return this.children.get(selector)!;
  }
  querySelectorAll() { return []; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  appended: Element[] = [];
  append(child: Element) { child.parent = this; this.appended.push(child); }
  replaceChildren() { this.appended.forEach(child => { child.parent = null; }); this.appended = []; }
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
  focus() { this.focused = true; }
  getBoundingClientRect() { return this.rect; }
  scrollIntoView(options: ScrollIntoViewOptions) { this.scrolls.push(options); }
  select() {}
  requestSubmit() { return this.handlers.get('submit')!({ preventDefault() {} }); }
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
  const timerDelays = new Map<number, number>();
  const handlers = new Map<string, (event: any) => void>();
  const generations: { body: any; onEvent: (event: GenerateEvent) => void; signal: AbortSignal; resolve: () => void }[] = [];
  let nextTimer = 0;
  let nextId = 0;
  const context = createContext({
    ...state, ApiError, Date, location: { pathname: '/', search: '', origin: 'https://blink.test' }, history: { replaceState() {} },
    getGallery: async () => ({ items: [], nextCursor: null }),
    document, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}` }, performance, AbortController,
    requestAnimationFrame: () => 1, clearInterval() {}, extractHtml, syncRaceLanes, buildPreviewDoc,
    getConfig: async () => ({ modelLabel: 'Kimi K3.1 Pro on Cerebras', compareEnabled: true, compareLabel: 'GPU', variantsEnabled: true, maxPromptChars: 500, publicOrigin: null }),
    generate: (body: unknown, onEvent: (event: GenerateEvent) => void, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
      generations.push({ body, onEvent, signal, resolve });
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    window: {
      innerHeight: 800,
      clearInterval() {},
      matchMedia: () => ({ matches: false }),
      addEventListener: (type: string, handler: (event: any) => void) => handlers.set(type, handler),
      setTimeout: (callback: () => void, delay: number) => {
        assert.ok(delay === 6000 || delay === 4000 || delay === 550 || delay === 700 || delay === 0);
        timers.set(++nextTimer, callback);
        timerDelays.set(nextTimer, delay);
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
    document, timers, timerDelays, generations, cerebras, compare,
    run(code: string) { return runInContext(code, context); },
    variants: runInContext('variantLanes', context) as TestLane[],
    choose(index: number) { context.index = index; runInContext('chooseVariation(variantLanes[index])', context); },
    completeChoice() {
      const id = runInContext('choiceTimer', context);
      timers.get(id)!();
      timers.delete(id);
    },
    variations(checked: boolean) {
      const toggle = document.querySelector('#variations');
      if ((toggle.getAttribute('aria-pressed') === 'true') !== checked) toggle.handlers.get('click')!({});
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

test('default branding confines model names to the two quiet credits', async () => {
  const ui = app();
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(ui.document.querySelector('#app').innerHTML, /Cerebras|Kimi/);
  assert.equal(ui.cerebras.root.querySelector('h3').textContent, 'Workspace');
  assert.equal(ui.cerebras.root.querySelector('.powered-by').textContent, 'Powered by Kimi K3.1 Pro on Cerebras');
  assert.equal(ui.document.querySelector('footer').textContent, 'Blink · Powered by Kimi K3.1 Pro on Cerebras');
  for (const lane of [ui.cerebras, ui.compare, ...ui.variants]) {
    assert.doesNotMatch(lane.root.getAttribute('aria-label')!, /Cerebras|Kimi/);
    assert.doesNotMatch(lane.iframe.title, /Cerebras|Kimi/);
    assert.doesNotMatch(lane.root.querySelector('.lane-status').textContent, /Cerebras|Kimi/);
  }
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(page, /<title>Blink — apps at the speed of thought<\/title>/);
  assert.doesNotMatch(page, /Cerebras|Kimi/);
  ui.race(true);
  assert.equal(ui.cerebras.root.querySelector('h3').textContent, 'Kimi K3.1 Pro on Cerebras');
  ui.race(false);
  assert.equal(ui.cerebras.root.querySelector('h3').textContent, 'Workspace');
});

test('model credits use text safely and race uses the configured model label', async () => {
  const ui = app(false, { getConfig: async () => ({ modelLabel: '<Custom & Model>', compareEnabled: true, compareLabel: 'GPU', variantsEnabled: true, maxPromptChars: 500 }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.document.querySelector('footer').textContent, 'Blink · Powered by <Custom & Model>');
  assert.equal(ui.cerebras.root.querySelector('.powered-by').textContent, 'Powered by <Custom & Model>');
  ui.race(true);
  assert.equal(ui.cerebras.root.querySelector('h3').textContent, '<Custom & Model>');
});

test('a finished frame can be picked during a run, stopping the rest and ignoring late events', async () => {
  const ui = app();
  ui.variations(true);
  const pending = ui.start();
  const generation = ui.generations[0];
  generation.onEvent({ type: 'delta', variant: 0, text: '<html>Keep me</html>' });
  generation.onEvent({ type: 'delta', variant: 1, text: '<html>Partial app</html>' });
  generation.onEvent({ type: 'done', variant: 0, stats, appId: 'picked' });
  assert.equal((ui.variants[0].root.querySelector('.use-variant') as any).disabled, false);
  assert.equal((ui.variants[1].root.querySelector('.use-variant') as any).disabled, true);
  ui.choose(0);
  assert.equal(generation.signal.aborted, true);
  for (const lane of ui.variants.slice(1)) {
    assert.equal(lane.root.querySelector('.lane-status').textContent, 'Stopped');
    assert.equal(lane.iframe.hidden, true);
  }
  generation.onEvent({ type: 'done', variant: 1, stats, appId: 'too-late' });
  ui.choose(1);
  assert.equal(ui.variants[0].root.classList.contains('chosen'), true);
  assert.equal(ui.variants[1].phase, 'stopped');
  await pending;
  ui.completeChoice();
  assert.equal(ui.cerebras.appId, 'picked');
  assert.equal(ui.cerebras.html, '<html>Keep me</html>');
  assert.equal(ui.cerebras.root.querySelector('.remix-prompt').focused, true);
  assert.equal(ui.document.querySelector('#prompt').value, '');
});

test('the empty film placeholder gives way to generation and returns on New', async () => {
  const ui = app();
  assert.equal(ui.document.querySelector('#lanes').hidden, true);
  assert.equal(ui.document.querySelector('#empty-film').hidden, false);
  assert.match(ui.document.querySelector('#app').innerHTML, /Your four versions will develop here\./);
  const pending = ui.start();
  assert.equal(ui.document.querySelector('#empty-film').hidden, true);
  assert.equal(ui.document.querySelector('#lanes').hidden, false);
  ui.document.querySelector('#new').handlers.get('click')!({});
  await pending;
  assert.equal(ui.document.querySelector('#lanes').hidden, true);
  assert.equal(ui.document.querySelector('#empty-film').hidden, false);
});

for (const reduced of [false, true]) {
  test(`generation and choice scroll into view with ${reduced ? 'instant' : 'smooth'} motion`, async () => {
    const ui = app();
    ui.run(`window.matchMedia = () => ({ matches: ${reduced} })`);
    const strip = ui.document.querySelector('#variations-strip');
    const workspace = ui.document.querySelector('#lanes');
    strip.rect = workspace.rect = { top: 1000, bottom: 1500 };
    ui.variations(true);
    const pending = ui.start();
    assert.equal(strip.scrolls[0].behavior, reduced ? 'instant' : 'smooth');
    const generation = ui.generations[0];
    generation.onEvent({ type: 'delta', variant: 0, text: '<html>App</html>' });
    generation.onEvent({ type: 'done', variant: 0, stats, appId: 'picked' });
    ui.choose(0);
    if (!reduced) ui.completeChoice();
    await pending;
    assert.equal(workspace.scrolls[0].behavior, reduced ? 'instant' : 'smooth');
    assert.equal(ui.cerebras.root.querySelector('.remix-prompt').focused, true);
  });
}

test('Blink submits through the prompt form and enables only for a nonempty idle prompt', async () => {
  const ui = app();
  const input = ui.document.querySelector('#prompt');
  const button = ui.document.querySelector('#submit') as any;
  assert.equal(button.disabled, true);
  input.value = '   ';
  input.handlers.get('input')!({});
  assert.equal(button.disabled, true);
  input.value = 'Make a clock';
  input.handlers.get('input')!({});
  assert.equal(button.disabled, false);
  assert.match(button.getAttribute('aria-label'), /Blink/);
  const pending = ui.document.querySelector('#prompt-form').requestSubmit();
  assert.equal(ui.generations[0].body.prompt, 'Make a clock');
  assert.equal(button.disabled, true);
  ui.generations[0].resolve();
  await pending;
  assert.equal(button.disabled, false);
});

test('solo generation scrolls an offscreen workspace and leaves an already visible workspace in place', async () => {
  const ui = app();
  const workspace = ui.document.querySelector('#lanes');
  let pending = ui.start();
  assert.equal(workspace.scrolls.length, 0);
  ui.generations[0].resolve();
  await pending;
  workspace.rect = { top: 900, bottom: 1400 };
  pending = ui.start();
  assert.equal(workspace.scrolls.length, 1);
  assert.equal(workspace.scrolls[0].behavior, 'smooth');
  ui.generations[1].resolve();
  await pending;
});

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
  assert.equal(ui.document.querySelector('#variations').getAttribute('aria-pressed'), 'false');
  ui.variations(true);
  assert.equal(ui.document.querySelector('#variations').getAttribute('aria-pressed'), 'true');
  const pending = ui.start();
  assert.equal(ui.generations.length, 1);
  const generation = ui.generations[0];
  assert.equal(generation.body.variants, 4);
  generation.onEvent({ type: 'queue', position: 3 });
  for (const lane of ui.variants) {
    assert.equal(lane.root.querySelector('.lane-status').textContent, "You're #3 in line");
    assert.equal(lane.root.getAttribute('data-state'), 'queued');
  }
  generation.onEvent({ type: 'queue', position: 0 });
  for (const index of [3, 0, 2, 1]) {
    generation.onEvent({ type: 'status', variant: index, phase: 'waiting_model' });
    assert.match(ui.variants[index].root.querySelector('.lane-status').textContent, /Waiting for the model/);
    assert.match(ui.variants[index].root.querySelector('.lane-status').textContent, /\d+\u00a0s$/);
    generation.onEvent({ type: 'delta', variant: index, text: `<html><body>Variation ${index}</body></html>` });
    ui.run(`renderLane(variantLanes[${index}])`);
    assert.equal(ui.variants[index].root.getAttribute('data-state'), 'developing');
    assert.match(ui.variants[index].root.querySelector('.code-rain').textContent, /Variation/);
    generation.onEvent({ type: 'done', variant: index, stats, appId: `saved-${index}` });
    assert.equal(ui.variants[index].root.getAttribute('data-state'), 'done');
    assert.equal(ui.variants[index].root.querySelector('.frame-metrics').textContent, '200 tok/s · 0.1 s');
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
  assert.equal(ui.variants[2].root.classList.contains('chosen'), true);
  assert.equal(ui.variants[0].root.classList.contains('chosen'), false);
  assert.match(ui.variants[2].root.innerHTML, /<svg class="circle"[^>]*>[\s\S]*?<path d=/);
  assert.equal(ui.document.querySelector('#variations-strip').hidden, false);
  ui.completeChoice();
  assert.equal(ui.document.querySelector('#variations').getAttribute('aria-pressed'), 'false');
  assert.equal(ui.cerebras.appId, 'saved-2');
  assert.equal(ui.cerebras.html, '<html><body>Variation 2</body></html>');
  assert.deepEqual(ui.cerebras.stats, stats);
  assert.ok(ui.cerebras.iframe.srcdoc.includes('Variation 2'));
  assert.equal(ui.document.querySelector('#variations-strip').hidden, true);
  assert.equal(ui.document.querySelector('#lanes').hidden, false);
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

for (const previewError of ['runtime', 'watchdog']) {
  test(`completed variations remain visible and selectable after a ${previewError} preview error`, async () => {
    const ui = app();
    ui.variations(true);
    const pending = ui.start();
    const generation = ui.generations[0];
    const lane = ui.variants[0];
    const button = lane.root.querySelector('.use-variant');
    generation.onEvent({ type: 'delta', variant: 0, text: '<html>App to fix</html>' });
    if (previewError === 'runtime') {
      ui.message('error', 'startup failed', lane.previewToken, lane.iframe.contentWindow);
    }
    generation.onEvent({ type: 'done', variant: 0, stats, appId: 'saved-with-preview-error' });
    if (previewError === 'watchdog') ui.expire();
    assert.ok(lane.error);
    assert.equal(lane.root.getAttribute('data-state'), 'preview-error');
    assert.equal(button.hidden, false);
    assert.equal((button as any).disabled, false);
    generation.resolve();
    await pending;
    assert.equal(button.hidden, false);
    assert.equal((button as any).disabled, false);
    button.handlers.get('click')!({});
    ui.completeChoice();
    assert.equal(ui.cerebras.appId, 'saved-with-preview-error');
    assert.equal(ui.cerebras.html, '<html>App to fix</html>');
  });
}

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
  // Retry keeps the original parent after a failed run.
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
  assert.match(ui.document.querySelector('#app').innerHTML, /id="gallery-title">Contact sheet<\/h2>/);
});

test('choosing a variant shows its circle for 700 ms and ignores further picks before expanding', () => {
  const ui = app();
  ui.run("choosingVariation = true; variationsStrip.hidden = false");
  for (const [index, lane] of ui.variants.entries()) {
    lane.html = `<html>Take ${index}</html>`;
    lane.phase = 'done';
  }
  ui.choose(0);
  assert.equal(ui.variants[0].root.classList.contains('chosen'), true);
  assert.match(ui.variants[0].root.innerHTML, /<svg class="circle"[^>]*>[\s\S]*?<path d=/);
  assert.equal(ui.document.querySelector('#variations-strip').hidden, false);
  assert.equal(ui.cerebras.html, '');
  const timer = ui.run('choiceTimer');
  assert.equal(ui.timerDelays.get(timer), 700);
  ui.choose(0);
  ui.choose(1);
  assert.equal(ui.variants[0].root.classList.contains('chosen'), true);
  assert.equal(ui.variants[1].root.classList.contains('chosen'), false);
  assert.equal(ui.run('choiceTimer'), timer);
  assert.equal(ui.timers.size, 1);
  ui.completeChoice();
  assert.equal(ui.cerebras.html, '<html>Take 0</html>');
  assert.equal(ui.document.querySelector('#variations-strip').hidden, true);
});

test('choosing a variant skips the delay with reduced motion', () => {
  const ui = app();
  ui.run("window.matchMedia = query => ({ matches: query === '(prefers-reduced-motion: reduce)' }); choosingVariation = true; variationsStrip.hidden = false");
  ui.variants[0].html = '<html>Reduced motion</html>';
  ui.variants[0].phase = 'done';
  ui.choose(0);
  assert.equal(ui.cerebras.html, '<html>Reduced motion</html>');
  assert.equal(ui.document.querySelector('#variations-strip').hidden, true);
  assert.equal(ui.run('choiceTimer'), 0);
});

test('frame edge prints finished and live seconds to one decimal', () => {
  const ui = app(false, { performance: { now: () => 245720 } });
  ui.run("variantLanes[0].text = '<html>App</html>'; variantLanes[0].stats = { totalMs: 244720, tokensPerSecond: 200, ttftMs: 10, outputTokens: 20 }; renderStats(variantLanes[0])");
  assert.equal(ui.variants[0].root.querySelector('.frame-metrics').textContent, '200 tok/s · 244.7 s');
  ui.run('variantLanes[0].stats = null; variantLanes[0].started = 1000; renderStats(variantLanes[0])');
  assert.equal(ui.variants[0].root.querySelector('.frame-metrics').textContent, '— tok/s · 244.7 s');
});

// This is the security boundary for every srcdoc write, including future preview paths.
test('every production srcdoc assignment goes through buildPreviewDoc', () => {
  const files = ts.sys.readDirectory(new URL('.', import.meta.url).pathname, ['.ts', '.html']);
  let assignments = 0;
  for (const file of files.filter(file => !file.endsWith('.test.ts'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\.srcdoc\s*=\s*([^;]+);/g)) {
      assignments++;
      assert.match(match[1], /^buildPreviewDoc\(/, file);
    }
    assert.doesNotMatch(text.replace(/\.srcdoc\s*=\s*buildPreviewDoc\([^;]+;/g, ''), /setAttribute\(\s*['"]srcdoc['"]|srcdoc\s*=/i, file);
  }
  assert.equal(assignments, 1);
});

for (const failure of ['429', '503', 'network', 'stream', 'invalid HTML']) {
  test(`remix failure (${failure}) keeps the saved preview, actions and next remix parent`, async t => {
    if (failure === '429' || failure === '503') {
      t.mock.method(globalThis, 'fetch', async () => Response.json({ retryAfterSec: 1 }, { status: Number(failure) }));
    }
    const ui = app(false, failure === '429' || failure === '503' ? { generate } :
      failure === 'network' ? { generate: async () => { throw new Error('Offline'); } } : {});
    ui.preview('<html>Original app</html>');
    ui.cerebras.appId = 'original';
    ui.cerebras.phase = 'done';
    ui.cerebras.stats = stats;
    const original = ui.cerebras.iframe;
    const pending = ui.start();
    assert.equal(ui.cerebras.html, '<html>Original app</html>');
    assert.equal(ui.cerebras.appId, 'original');
    assert.equal(ui.cerebras.iframe, original);
    if (failure === 'stream' || failure === 'invalid HTML') {
      const generation = ui.generations[0];
      generation.onEvent({ type: 'delta', variant: 0, text: failure === 'stream' ? '<html>Unfinished replacement</html>' : 'not an app' });
      assert.equal(ui.cerebras.html, '<html>Original app</html>');
      assert.equal(ui.cerebras.appId, 'original');
      generation.onEvent(failure === 'stream'
        ? { type: 'error', variant: 0, message: 'Provider failed', retryable: true }
        : { type: 'done', variant: 0, stats, appId: null });
      generation.resolve();
    }
    await pending;
    assert.equal(ui.cerebras.iframe, original);
    assert.equal(ui.cerebras.html, '<html>Original app</html>');
    assert.equal(ui.cerebras.appId, 'original');
    assert.deepEqual(ui.cerebras.stats, stats);
    assert.equal(ui.cerebras.phase, 'done');
    assert.ok(ui.cerebras.error);
    assert.equal((ui.cerebras.root.querySelector('.share') as any).disabled, false);
    assert.equal((ui.cerebras.root.querySelector('.download') as any).disabled, false);
    ui.run('generate = (body) => { globalThis.nextBody = body; return Promise.resolve(); }');
    await ui.start();
    assert.equal(ui.run('nextBody.remixOf'), 'original');
  });
}

test('race requests share a fresh runId and retain their own remix parents', async () => {
  const ui = app();
  ui.race(true);
  ui.preview('<html>Cerebras</html>');
  ui.cerebras.appId = 'parent-cerebras';
  ui.cerebras.phase = 'done';
  ui.run("setPreview(compare, '<html>Compare</html>')");
  ui.compare.appId = 'parent-compare';
  ui.compare.phase = 'done';
  let previousId = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = ui.start();
    const lanes = ui.generations.slice(attempt * 2);
    const runId = lanes[0].body.runId;
    assert.match(runId, /^[a-f0-9]{32}$/);
    assert.ok(runId.length <= 64);
    assert.notEqual(runId, previousId);
    assert.equal(lanes[1].body.runId, runId);
    assert.deepEqual(lanes.map(lane => lane.body.remixOf), ['parent-cerebras', 'parent-compare']);
    lanes.forEach(lane => {
      lane.onEvent({ type: 'error', variant: 0, message: 'Busy', retryable: true });
      lane.resolve();
    });
    await pending;
    previousId = runId;
  }
});

test('sharing reloads the first gallery page and replaces previously loaded cards', async () => {
  const cursors: (string | null)[] = [];
  let shared = false;
  const item = (id: string) => ({ id, title: id, prompt: 'App', createdAt: 1 });
  const ui = app(false, {
    getGallery: async (cursor: string | null) => {
      cursors.push(cursor);
      return { items: shared ? [item('new'), item('old')] : [item(cursor ? 'older' : 'old')], nextCursor: shared ? null : '10' };
    },
    shareApp: async () => { shared = true; return '/a/new'; },
    navigator: { clipboard: { writeText: async () => {} } },
  });
  await new Promise(resolve => setImmediate(resolve));
  await ui.run('loadGalleryPage()');
  ui.cerebras.appId = 'new';
  await ui.run('shareLane(cerebras)');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cursors, [null, '10', null]);
  const grid = ui.document.querySelector('#gallery-grid');
  assert.deepEqual(grid.appended.map(card => card.querySelector('h3').textContent), ['new', 'old']);
});

test('a successful remix replaces the saved app only on completion', async () => {
  const ui = app();
  ui.preview('<html>Original</html>');
  ui.cerebras.appId = 'original';
  ui.cerebras.phase = 'done';
  const iframe = ui.cerebras.iframe;
  const pending = ui.start();
  const generation = ui.generations[0];
  generation.onEvent({ type: 'delta', variant: 0, text: '<html>Replacement</html>' });
  assert.equal(ui.cerebras.iframe, iframe);
  assert.equal(ui.cerebras.html, '<html>Original</html>');
  assert.equal(ui.cerebras.appId, 'original');
  generation.onEvent({ type: 'done', variant: 0, stats, appId: 'replacement' });
  generation.resolve();
  await pending;
  assert.equal(ui.cerebras.html, '<html>Replacement</html>');
  assert.equal(ui.cerebras.appId, 'replacement');
  assert.notEqual(ui.cerebras.iframe, iframe);
});

test('workspace Remix uses the existing generation flow and saved parent', async () => {
  const ui = app();
  ui.preview('<html>Original</html>');
  ui.cerebras.appId = 'original';
  ui.cerebras.phase = 'done';
  const input = ui.cerebras.root.querySelector('.remix-prompt');
  input.value = 'Add a streak counter';
  ui.cerebras.root.querySelector('.remix-form').handlers.get('submit')!({ preventDefault() {} });
  const generation = ui.generations[0];
  assert.equal(generation.body.prompt, 'Add a streak counter');
  assert.equal(generation.body.remixOf, 'original');
  assert.equal(generation.body.variants, 1);
  generation.onEvent({ type: 'delta', variant: 0, text: '<html>With streaks</html>' });
  generation.onEvent({ type: 'done', variant: 0, stats, appId: 'remixed' });
  generation.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.cerebras.appId, 'remixed');
  assert.equal(input.value, '');
});

test('a gallery refresh ignores an older page that finishes after sharing', async () => {
  let resolveOld!: (page: unknown) => void;
  let calls = 0;
  const item = (id: string) => ({ id, title: id, prompt: 'App', createdAt: 1 });
  const ui = app(false, {
    getGallery: () => ++calls === 1 ? new Promise(resolve => { resolveOld = resolve; }) :
      Promise.resolve({ items: [item('new')], nextCursor: null }),
    shareApp: async () => '/a/new',
    navigator: { clipboard: { writeText: async () => {} } },
  });
  ui.cerebras.appId = 'new';
  await ui.run('shareLane(cerebras)');
  resolveOld({ items: [item('old')], nextCursor: '10' });
  await new Promise(resolve => setImmediate(resolve));
  const grid = ui.document.querySelector('#gallery-grid');
  assert.deepEqual(grid.appended.map(card => card.querySelector('h3').textContent), ['new']);
  assert.equal(ui.document.querySelector('#load-more').hidden, true);
});
