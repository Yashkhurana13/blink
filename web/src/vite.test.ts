import assert from 'node:assert/strict';
import test from 'node:test';
import config from '../../vite.config.ts';

test('dev proxies API, raw previews, share pages and social cards to the backend', () => {
  for (const path of ['/api', '/raw', '/a', '/og.png']) {
    assert.equal(config.server?.proxy?.[path], 'http://127.0.0.1:5174');
  }
});
