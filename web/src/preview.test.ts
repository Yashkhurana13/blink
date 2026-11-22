import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildPreviewDoc } from './preview.ts';

function previewScript(html: string) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'preview bootstrap script is present');
  return match[1];
}

const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">`;

for (const [name, doctype, generated] of [
  ['normal document', '<!doctype html>', '\n<html lang="en"><head>\n<title>App</title><style>body { color: red }</style><meta name="app" content="yes"><script>start()</script></head><body>Hello</body></html>'],
  ['comment containing head', '<!doctype html>', '<html><!-- <head> --><head></head><body>Hello<script>start()</script></body></html>'],
  ['comment containing html', '', '<!-- <html><head> --><div>Hello</div>'],
  ['unclosed comment', '', '<html><!-- <head><script>start()</script><body>Hello'],
  ['script before head', '<!doctype html>', '<html><script>start()</script><head><title>App</title></head><body>Hello</body></html>'],
  ['no doctype', '', '<html><head></head><body>Hello</body></html>'],
  ['uppercase doctype', '<!DOCTYPE HTML>', '<HTML><HEAD data-app="yes"><TITLE>App</TITLE></HEAD><BODY>Hello</BODY></HTML>'],
  ['leading BOM and whitespace', '\uFEFF \n\t<!DoCtYpE html>', '\n<html><head></head><body>Hello</body></html>'],
  ['leading whitespace without doctype', '', '\uFEFF \n\t<div>Hello</div>'],
  ['nonleading doctype', '', '<!-- keep --><!doctype html><div>Hello</div>'],
  ['fragment', '', '<script>start()</script><div>Hello</div>'],
  ['empty document', '', ''],
]) {
  test(`puts the trusted prefix before all generated markup: ${name}`, () => {
    const html = doctype + generated;
    const doc = buildPreviewDoc(html, 'token');
    assert.ok(doc.startsWith('<!doctype html><meta charset="utf-8">' + csp + '<script>'));
    assert.equal(doc.split(csp).length - 1, 1);
    assert.ok(doc.indexOf(csp) < doc.indexOf('<script>'));
    const bootstrapEnd = doc.indexOf('</script>') + '</script>'.length;
    assert.equal(doc.slice(0, bootstrapEnd), buildPreviewDoc('', 'token'));
    assert.equal(doc.slice(bootstrapEnd), generated);
  });
}

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

test('embeds the token safely and posts readiness on DOMContentLoaded, load, and a frame', () => {
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
  handlers.get('DOMContentLoaded')!();
  assert.equal(messages.length, 4);
  handlers.get('load')!();
  assert.equal(messages.length, 5);
  assert.equal(frames.length, 1);
  frames[0]();
  assert.equal(messages.length, 6);
  for (const message of messages.slice(3)) {
    assert.equal(message.blinkPreview, token);
    assert.equal(message.type, 'ready');
  }
});
