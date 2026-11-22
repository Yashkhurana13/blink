import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import type { GenerateEvent } from './api.ts';
import { extractHtml } from './extract.ts';
import { syncRaceLanes } from './lanes.ts';
import { buildPreviewDoc } from './preview.ts';

// Exercise main's event handlers without a browser or a new DOM dependency.
class Element {
  children = new Map<string, Element>();
  handlers = new Map<string, (event: any) => any>();
  attributes = new Map<string, string>();
  parent: Element | null = null;
  hidden = false;
  checked = false;
  value = '';
  title = '';
  srcdoc = '';
  textContent = '';
  contentWindow = {};
  classList = { toggle() {} };
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
}

interface TestLane {
  iframe: Element;
  html: string;
  error: string;
  previewToken: string;
  conversationId: string;
  stats: unknown;
}

const source = ts.transpileModule(
  readFileSync(new URL('./main.ts', import.meta.url), 'utf8').replace(/^import .*;\n/gm, ''),
  { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } },
).outputText;
const stats = { ttftMs: 10, totalMs: 100, outputTokens: 20, tokensPerSecond: 200, tokensEstimated: false };

function app(hidden = false) {
  const document = Object.assign(new Element(), { hidden, createElement: () => new Element() });
  const timers = new Map<number, () => void>();
  const handlers = new Map<string, (event: any) => void>();
  const generations: { onEvent: (event: GenerateEvent) => void; resolve: () => void }[] = [];
  let nextTimer = 0;
  let nextId = 0;
  const context = createContext({
    document, crypto: { randomUUID: () => `id-${++nextId}` }, performance, AbortController,
    requestAnimationFrame: () => 1, clearInterval() {}, extractHtml, syncRaceLanes, buildPreviewDoc,
    getConfig: async () => ({ compareEnabled: true }),
    generate: (_body: unknown, onEvent: (event: GenerateEvent) => void) => new Promise<void>(resolve => {
      generations.push({ onEvent, resolve });
    }),
    window: {
      addEventListener: (type: string, handler: (event: any) => void) => handlers.set(type, handler),
      setTimeout: (callback: () => void, delay: number) => {
        assert.equal(delay, 6000);
        timers.set(++nextTimer, callback);
        return nextTimer;
      },
      clearTimeout: (id: number) => timers.delete(id), setInterval: () => 0,
    },
  });
  runInContext(source, context);
  const cerebras = runInContext('cerebras', context) as TestLane;
  const compare = runInContext('compare', context) as TestLane;
  return {
    document, timers, generations, cerebras, compare,
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
    generation.onEvent({ type: 'delta', text: '<html><body>App</body></html>' });
    const iframe = ui.cerebras.iframe;
    const token = ui.cerebras.previewToken;
    if (changed) generation.onEvent({ type: 'delta', text: '<!-- final markup --></html>' });
    generation.onEvent({ type: 'done', stats });
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
    generation.onEvent({ type: 'delta', text: `<html>Race result ${index}</html>` });
    generation.onEvent({ type: 'done', stats });
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
  solo.onEvent({ type: 'delta', text: '<html>Newest solo remix</html>' });
  solo.onEvent({ type: 'done', stats });
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
