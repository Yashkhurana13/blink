import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AppDatabase } from './db.ts';

test('apps persist with URL-safe IDs, private defaults, and gallery cursors without timestamp ties', t => {
  const dir = mkdtempSync(join(tmpdir(), 'blink-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { BLINK_DATA_DIR: dir };
  let db = new AppDatabase(env);
  t.after(() => db.close());
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const app = db.save({ title: 'Title', prompt: 'clock', html: '<html></html>', ipHash: 'hash', parentId: null });
    assert.match(app.id, /^[A-Za-z0-9_-]{10}$/);
    assert.equal(app.shared, false);
    ids.push(app.id);
    if (i) db.share(app.id, 'hash');
  }
  assert.deepEqual(db.gallery(undefined, 2).items.map(a => a.id), ids.slice(2).reverse());
  const cursor = db.gallery(undefined, 2).nextCursor!;
  assert.deepEqual(db.gallery(cursor, 2).items.map(a => a.id), [ids[1]]);
  assert.equal(db.gallery(cursor, 2).nextCursor, null);
  db.close();
  db = new AppDatabase(env);
  assert.equal(db.get(ids[0])?.html, '<html></html>');
  assert.equal(db.share(ids[0], 'stranger'), false);
  db.hide(ids[3]);
  assert.deepEqual(db.gallery(undefined, 24).items.map(a => a.id), [ids[2], ids[1]]);
});

test('reports are unique by app and hash, and three distinct reports hide an app', t => {
  const dir = mkdtempSync(join(tmpdir(), 'blink-db-'));
  const db = new AppDatabase({ BLINK_DATA_DIR: dir });
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const app = db.save({ title: 'x', prompt: 'x', html: '<html>x</html>', ipHash: 'creator', parentId: null });
  db.share(app.id, 'creator');
  db.report(app.id, 'one');
  db.report(app.id, 'one');
  db.report(app.id, 'two');
  assert.equal(db.get(app.id)?.hidden, false);
  db.report(app.id, 'three');
  assert.equal(db.get(app.id)?.hidden, true);
  assert.deepEqual(db.gallery(undefined, 24).items, []);
});
