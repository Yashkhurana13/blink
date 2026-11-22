import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildPreviewDoc } from './preview.ts';

function previewScript(html: string) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'preview bootstrap script is present');
  return match[1];
}

test('inserts the bootstrap first in head and preserves all original HTML', () => {
  const html = '<!doctype html>\n<html lang="en"><head>\n<title>App</title><script>start()</script></head><body>Hello</body></html>';
  const doc = buildPreviewDoc(html, 'preview-token');
  assert.ok(doc.startsWith('<!doctype html>\n<html lang="en"><head><script>'));
  assert.equal(doc.replace(/<script>[\s\S]*?<\/script>/, ''), html);
});

test('inserts after html when head is absent, or at the start for a fragment', () => {
  for (const [html, prefix] of [
    ['<!doctype html><html lang="en"><body>Hello</body></html>', '<!doctype html><html lang="en"><script>'],
    ['<div>Hello</div>', '<script>'],
    ['', '<script>'],
  ]) {
    const doc = buildPreviewDoc(html, 'token');
    assert.ok(doc.startsWith(prefix));
    assert.equal(doc.replace(/<script>[\s\S]*?<\/script>/, ''), html);
  }
});

test('recognizes uppercase head and html tags', () => {
  for (const [html, prefix] of [
    ['<HTML><HEAD data-app="yes"><TITLE>App</TITLE></HEAD></HTML>', '<HTML><HEAD data-app="yes"><script>'],
    ['<HTML lang="en"><BODY>App</BODY></HTML>', '<HTML lang="en"><script>'],
  ]) {
    const doc = buildPreviewDoc(html, 'token');
    assert.ok(doc.startsWith(prefix));
    assert.equal(doc.replace(/<script>[\s\S]*?<\/script>/, ''), html);
  }
});

test('provides isolated storage and dialog stubs before app startup', () => {
  const window = {} as Window;
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(window, name, {
      configurable: true,
      get() { throw new Error('SecurityError: opaque origin'); },
    });
  }
  Object.assign(window, { addEventListener() {} });
  runInNewContext(previewScript(buildPreviewDoc('<head></head>', 'token')), { window });
  const storage = window.localStorage;
  assert.equal(storage.getItem('missing'), null);
  storage.setItem('score', 42 as unknown as string);
  storage.setItem('other', 'value');
  assert.equal(storage.getItem('score'), '42');
  assert.equal(storage.length, 2);
  assert.equal(storage.key(0), 'score');
  assert.equal(storage.key(2), null);
  assert.equal(window.sessionStorage.getItem('score'), null);
  storage.removeItem('score');
  assert.equal(storage.getItem('score'), null);
  assert.equal(storage.length, 1);
  storage.clear();
  assert.equal(storage.length, 0);
  assert.equal(window.alert('hello'), undefined);
  assert.equal(window.confirm('hello'), false);
  assert.equal(window.prompt('hello'), null);
});

test('embeds the token safely and forwards errors, rejections, and readiness after load and a frame', () => {
  const token = 'preview-"</script><script>bad()</script>';
  const handlers = new Map<string, (event?: unknown) => void>();
  const frames: (() => void)[] = [];
  const messages: { blinkPreview: string; type: string; message?: string }[] = [];
  const window = {
    addEventListener(type: string, handler: (event?: unknown) => void) { handlers.set(type, handler); },
    requestAnimationFrame(callback: () => void) { frames.push(callback); },
  };
  const doc = buildPreviewDoc('<head></head>', token);
  assert.equal((doc.match(/<\/script>/g) || []).length, 1);
  runInNewContext(previewScript(doc), {
    window,
    parent: { postMessage(message: typeof messages[number], target: string) {
      assert.equal(target, '*');
      messages.push(message);
    } },
  });
  assert.equal(messages.length, 0);
  handlers.get('error')!({ message: 'startup failed' });
  handlers.get('unhandledrejection')!({ reason: new Error('async failed') });
  handlers.get('unhandledrejection')!({ reason: 'string rejection' });
  assert.deepEqual(messages.map(message => [message.blinkPreview, message.type, message.message]), [
    [token, 'error', 'startup failed'],
    [token, 'error', 'async failed'],
    [token, 'error', 'string rejection'],
  ]);
  handlers.get('load')!();
  assert.equal(messages.length, 3);
  assert.equal(frames.length, 1);
  frames[0]();
  assert.equal(messages[3].blinkPreview, token);
  assert.equal(messages[3].type, 'ready');
});
