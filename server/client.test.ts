import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';
import { createClientIdentity } from './client.ts';

function request(peer: string, forwarded?: string) {
  return { socket: { remoteAddress: peer }, headers: { 'cf-connecting-ip': forwarded } } as IncomingMessage;
}

test('only loopback TCP peers may supply CF-Connecting-IP; identity is salted SHA-256', t => {
  const dir = mkdtempSync(join(tmpdir(), 'blink-client-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const identify = createClientIdentity({ BLINK_DATA_DIR: dir, BLINK_SALT: 'secret' });
  const hash = (ip: string) => createHash('sha256').update('secret').update(ip).digest('hex');
  for (const peer of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
    assert.equal(identify(request(peer, '203.0.113.1')), hash('203.0.113.1'));
  }
  assert.equal(identify(request('203.0.113.2', '203.0.113.1')), hash('203.0.113.2'));
  assert.equal(identify(request('127.0.0.1', 'bad, ip')), hash('127.0.0.1'));
  assert.equal(identify(request('127.0.0.1')), hash('127.0.0.1'));
});

test('generated salt survives restart and is never a raw client IP', t => {
  const dir = mkdtempSync(join(tmpdir(), 'blink-client-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { BLINK_DATA_DIR: dir };
  const first = createClientIdentity(env)(request('203.0.113.1'));
  const salt = readFileSync(join(dir, 'salt'), 'utf8');
  assert.ok(salt.length >= 32);
  assert.equal(createClientIdentity(env)(request('203.0.113.1')), first);
  assert.notEqual(first, '203.0.113.1');
  assert.notEqual(createClientIdentity({ ...env, BLINK_SALT: 'other' })(request('203.0.113.1')), first);
});
