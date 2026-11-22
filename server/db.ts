import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataDirectory } from './client.ts';

export type SavedApp = {
  id: string; title: string; prompt: string; html: string; createdAt: number;
  ipHash: string; creatorHash: string | null; shared: boolean; hidden: boolean; parentId: string | null;
};
type NewApp = Pick<SavedApp, 'title' | 'prompt' | 'html' | 'ipHash' | 'creatorHash' | 'parentId'>;

export function appMetadata(app: SavedApp, publicParentId: string | null) {
  return {
    id: app.id, title: app.title, prompt: app.prompt, createdAt: app.createdAt,
    shared: app.shared, parentId: publicParentId,
  };
}

export class AppDatabase {
  private db: DatabaseSync;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const dir = dataDirectory(env);
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, 'blink.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, html TEXT NOT NULL,
        created_at INTEGER NOT NULL, ip_hash TEXT NOT NULL, creator_hash TEXT,
        shared INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, parent_id TEXT
      );
      CREATE TABLE IF NOT EXISTS reports (
        app_id TEXT NOT NULL, ip_hash TEXT NOT NULL, PRIMARY KEY(app_id, ip_hash)
      );
      CREATE INDEX IF NOT EXISTS apps_gallery ON apps(shared, hidden, created_at DESC);
    `);
    if (!this.db.prepare('PRAGMA table_info(apps)').all().some(column => column.name === 'creator_hash')) {
      // Legacy rows deliberately remain unowned; an IP hash is never a creator credential.
      this.db.exec('ALTER TABLE apps ADD COLUMN creator_hash TEXT');
    }
  }

  get(id: string): SavedApp | undefined {
    const row = this.db.prepare('SELECT * FROM apps WHERE id = ?').get(id);
    if (!row) return undefined;
    return {
      id: String(row.id), title: String(row.title), prompt: String(row.prompt), html: String(row.html),
      createdAt: Number(row.created_at), ipHash: String(row.ip_hash),
      creatorHash: row.creator_hash === null ? null : String(row.creator_hash), shared: Boolean(row.shared),
      hidden: Boolean(row.hidden), parentId: row.parent_id === null ? null : String(row.parent_id),
    };
  }

  save(input: NewApp): SavedApp {
    const id = randomBytes(8).toString('base64url').slice(0, 10);
    // Strictly increasing timestamps keep the timestamp-only gallery cursor lossless.
    this.db.prepare(`INSERT INTO apps (id, title, prompt, html, created_at, ip_hash, creator_hash, parent_id)
      VALUES (?, ?, ?, ?, MAX(?, COALESCE((SELECT MAX(created_at) + 1 FROM apps), 0)), ?, ?, ?)`)
      .run(id, input.title, input.prompt, input.html, Date.now(), input.ipHash, input.creatorHash, input.parentId);
    return this.get(id)!;
  }

  share(id: string, creatorHash: string) {
    return this.db.prepare('UPDATE apps SET shared = 1 WHERE id = ? AND creator_hash = ?').run(id, creatorHash).changes > 0;
  }

  hide(id: string) {
    return this.db.prepare('UPDATE apps SET hidden = 1 WHERE id = ?').run(id).changes > 0;
  }

  report(id: string, ipHash: string) {
    const app = this.get(id);
    if (!app?.shared || app.hidden) return;
    this.db.exec('BEGIN');
    try {
      // Version the normalized keys: legacy per-address hashes cannot establish distinct /64s.
      this.db.prepare('INSERT OR IGNORE INTO reports(app_id, ip_hash) VALUES (?, ?)').run(id, `v2:${ipHash}`);
      this.db.prepare(`UPDATE apps SET hidden = 1 WHERE id = ?
        AND (SELECT COUNT(*) FROM (
          SELECT 1 FROM reports WHERE app_id = ? AND ip_hash GLOB 'v2:*' LIMIT 3
        )) >= 3`).run(id, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  gallery(cursor: string | undefined, limit: number) {
    const rows = this.db.prepare(`SELECT id, title, prompt, created_at AS createdAt FROM apps
      WHERE shared = 1 AND hidden = 0 AND created_at < ? ORDER BY created_at DESC LIMIT ?`)
      .all(cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(cursor), limit + 1);
    const items = rows.slice(0, limit).map(row => ({
      id: String(row.id), title: String(row.title), prompt: String(row.prompt), createdAt: Number(row.createdAt),
    }));
    return { items, nextCursor: rows.length > limit ? String(items.at(-1)!.createdAt) : null };
  }

  close() { this.db.close(); }
}
