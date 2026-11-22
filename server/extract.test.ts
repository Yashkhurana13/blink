import assert from 'node:assert/strict';
import test from 'node:test';
import { extractHtml } from './extract.ts';

const html = '<!doctype html>\n<html><body>Hello</body></html>';

test('extracts fenced HTML without Markdown fences', () => {
  assert.equal(extractHtml('```html\n' + html + '\n```'), html);
});

test('extracts unfenced HTML', () => {
  assert.equal(extractHtml(html), html);
  assert.equal(extractHtml('<html lang="en">Hello</html>'), '<html lang="en">Hello</html>');
});

test('ignores leading chatter and trailing commentary', () => {
  assert.equal(extractHtml('Here is your app:\n' + html + '\nEnjoy!'), html);
});

test('waits for complete HTML and requires an opening tag', () => {
  for (const text of ['', '```html\n<!doctype html><html>Hello', '<html>Hello</ht', 'Hello</html>']) {
    assert.equal(extractHtml(text), null);
  }
});

test('matches uppercase DOCTYPE and HTML tags', () => {
  const upper = '<!DOCTYPE HTML>\n<HTML><BODY>Hello</BODY></HTML>';
  assert.equal(extractHtml(upper), upper);
});

test('uses the first opening and last closing tag', () => {
  const text = '<html><body>First</body></html>\n<html>Last</html>';
  assert.equal(extractHtml(text), text);
  assert.equal(extractHtml('</html> chatter <html>incomplete'), null);
});

test('extracts and decodes the full app title with a fallback for missing titles', async () => {
  const { extractTitle } = await import('./extract.ts');
  assert.equal(extractTitle('<html><title>A &amp; B &#x1f31f; &#39;ok&#39;</title></html>'), "A & B 🌟 'ok'");
  assert.equal(extractTitle('<html><title></title></html>'), 'Untitled app');
  assert.equal(extractTitle('<html></html>'), 'Untitled app');
  const title = 'long title '.repeat(30);
  assert.equal(extractTitle(`<html><title>${title}</title></html>`), title.trim());
});
