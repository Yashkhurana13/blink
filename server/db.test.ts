import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
    const app = db.save({ title: 'Title', prompt: 'clock', html: '<html></html>', ipHash: 'hash', creatorHash: 'hash', parentId: null });
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
  const app = db.save({ title: 'x', prompt: 'x', html: '<html>x</html>', ipHash: 'creator', creatorHash: 'creator', parentId: null });
  db.share(app.id, 'creator');
  db.report(app.id, 'one');
  db.report(app.id, 'one');
  db.report(app.id, 'two');
  assert.equal(db.get(app.id)?.hidden, false);
  db.report(app.id, 'three');
  assert.equal(db.get(app.id)?.hidden, true);
  assert.deepEqual(db.gallery(undefined, 24).items, []);
});

test('legacy apps migrate with no creator, so knowing their old IP hash grants no ownership', t => {
  const dir = mkdtempSync(join(tmpdir(), 'blink-migration-'));
  const legacy = new DatabaseSync(join(dir, 'blink.db'));
  legacy.exec(`CREATE TABLE apps (
    id TEXT PRIMARY KEY, title TEXT, prompt TEXT, html TEXT, created_at INTEGER, ip_hash TEXT,
    shared INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, parent_id TEXT
  ); INSERT INTO apps (id, title, prompt, html, created_at, ip_hash)
    VALUES ('legacy_app', 'Old app', 'clock', '<html>old</html>', 1, 'old-ip-hash');`);
  legacy.close();
  const db = new AppDatabase({ BLINK_DATA_DIR: dir });
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(db.get('legacy_app')?.creatorHash, null);
  assert.equal(db.share('legacy_app', 'old-ip-hash'), false);
});

test('private and hidden reports leave SQLite unchanged', t => {
  const dir = mkdtempSync(join(tmpdir(), 'blink-reports-'));
  const db = new AppDatabase({ BLINK_DATA_DIR: dir });
  const observer = new DatabaseSync(join(dir, 'blink.db'));
  t.after(() => { observer.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const privateApp = db.save({ title: 'x', prompt: 'x', html: '<html>x</html>', ipHash: 'ip', creatorHash: 'creator', parentId: null });
  const hidden = db.save({ title: 'x', prompt: 'x', html: '<html>x</html>', ipHash: 'ip', creatorHash: 'creator', parentId: null });
  db.share(hidden.id, 'creator');
  db.hide(hidden.id);
  const before = observer.prepare('PRAGMA data_version').get();
  for (const id of [privateApp.id, hidden.id]) db.report(id, 'reporter');
  assert.deepEqual(observer.prepare('PRAGMA data_version').get(), before);
  assert.equal(observer.prepare('SELECT COUNT(*) AS n FROM reports').get()!.n, 0);
});

test('legacy report hashes cannot contribute to the normalized three-identity threshold', t => {
  const dir = mkdtempSync(join(tmpdir(), 'blink-legacy-reports-'));
  const db = new AppDatabase({ BLINK_DATA_DIR: dir });
  const legacy = new DatabaseSync(join(dir, 'blink.db'));
  t.after(() => { legacy.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const app = db.save({ title: 'x', prompt: 'x', html: '<html>x</html>', ipHash: 'ip', creatorHash: 'creator', parentId: null });
  db.share(app.id, 'creator');
  // Old salted hashes cannot be converted back into /64 identities.
  legacy.prepare('INSERT INTO reports(app_id, ip_hash) VALUES (?, ?), (?, ?)')
    .run(app.id, 'old-ipv6-address-one', app.id, 'old-ipv6-address-two');
  db.report(app.id, 'normalized-network-one');
  db.report(app.id, 'normalized-network-one');
  db.report(app.id, 'normalized-network-two');
  assert.equal(db.get(app.id)?.hidden, false);
  db.report(app.id, 'normalized-network-three');
  assert.equal(db.get(app.id)?.hidden, true);
});
