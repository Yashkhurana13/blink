import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClientIdentity } from './client.ts';
import { AppDatabase, appMetadata } from './db.ts';
import { canRead, generate, json } from './generate.ts';
import { getConfig, getPublicOrigin } from './lanes.ts';
import { positiveInteger, Scheduler } from './queue.ts';
import { RAW_CSP, sharePage } from './share.ts';

const webRoot = fileURLToPath(new URL('../dist/web/', import.meta.url));
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function adminAuthorized(authorization: string | undefined, token: string) {
  // Hash both values to a fixed length so even different-length tokens use timingSafeEqual.
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(authorization ?? ''), hash(`Bearer ${token}`));
}

export function createAppServer(env: NodeJS.ProcessEnv = process.env) {
  const db = new AppDatabase(env);
  const identify = createClientIdentity(env);
  const scheduler = new Scheduler({
    maxConcurrent: positiveInteger(env.MAX_CONCURRENT, 8),
    maxQueue: positiveInteger(env.MAX_QUEUE, 40, 0),
    hourlyLimit: positiveInteger(env.HOURLY_LIMIT, 30),
  });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      if ((pathname === '/api' || pathname.startsWith('/api/')) && req.method !== 'GET') {
        if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          json(res, 415, { error: 'Content-Type must be application/json' });
          return;
        }
        const allowedOrigins = [
          `http://${req.headers.host}`, 'http://127.0.0.1:5173', 'http://localhost:5173',
          getPublicOrigin(env),
          ...(env.BLINK_ALLOWED_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean),
        ];
        if (req.headers.origin !== undefined && !allowedOrigins.includes(req.headers.origin)) {
          json(res, 403, { error: 'Origin not allowed' });
          return;
        }
      }
      if (pathname === '/api/config' && req.method === 'GET') {
        json(res, 200, getConfig(env));
        return;
      }
      if (pathname === '/api/generate' && req.method === 'POST') {
        await generate(req, res, env, db, scheduler, identify(req));
        return;
      }
      if (pathname === '/api/gallery' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 24);
        const cursor = url.searchParams.get('cursor') ?? undefined;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
          || (cursor !== undefined && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))))) {
          json(res, 400, { error: 'Invalid gallery cursor or limit' });
          return;
        }
        json(res, 200, db.gallery(cursor, limit));
        return;
      }
      const admin = pathname.match(/^\/api\/admin\/apps\/([A-Za-z0-9_-]{10})\/hide$/);
      if (admin && req.method === 'POST') {
        if (!env.ADMIN_TOKEN) json(res, 404, { error: 'Not found' });
        else if (!adminAuthorized(req.headers.authorization, env.ADMIN_TOKEN)) json(res, 401, { error: 'Unauthorized' });
        else if (!db.hide(admin[1])) json(res, 404, { error: 'Not found' });
        else json(res, 200, { ok: true });
        return;
      }
      const appRoute = pathname.match(/^\/api\/apps\/([A-Za-z0-9_-]{10})(?:\/(share|report))?$/);
      if (appRoute) {
        const app = db.get(appRoute[1]);
        const ipHash = identify(req);
        if (!app) json(res, 404, { error: 'Not found' });
        else if (!appRoute[2] && req.method === 'GET') {
          if (canRead(app, ipHash)) json(res, 200, appMetadata(app));
          else json(res, 404, { error: 'Not found' });
        } else if (appRoute[2] === 'share' && req.method === 'POST') {
          if (db.share(app.id, ipHash)) json(res, 200, { url: `/a/${app.id}` });
          else json(res, 403, { error: 'Only the creator can share this app' });
        } else if (appRoute[2] === 'report' && req.method === 'POST' && app.shared) {
          db.report(app.id, ipHash);
          json(res, 200, { ok: true });
        } else json(res, 404, { error: 'Not found' });
        return;
      }
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        json(res, 404, { error: 'Not found' });
        return;
      }
      const pageRoute = pathname.match(/^\/(a|raw)\/([A-Za-z0-9_-]{10})$/);
      if (pageRoute && req.method === 'GET') {
        const app = db.get(pageRoute[2]);
        if (!app || (pageRoute[1] === 'a' ? !app.shared || app.hidden : !canRead(app, identify(req)))) {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Not found · Blink</title><h1>App not found</h1><a href="/">Make your own</a>');
        } else if (pageRoute[1] === 'raw') {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': RAW_CSP,
            'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
          });
          res.end(app.html);
        } else {
          const origin = getPublicOrigin(env) ?? `http://${req.headers.host ?? 'localhost'}`;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(sharePage(app, origin));
        }
        return;
      }
      if (pathname === '/og.png' && req.method === 'GET') {
        const body = await readFile(new URL('./assets/og.png', import.meta.url));
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(body);
        return;
      }
      const file = resolve(webRoot, `.${['/', '/gallery', '/gallery/'].includes(pathname) ? '/index.html' : pathname}`);
      if (!file.startsWith(resolve(webRoot) + sep)) {
        res.writeHead(404).end('Not found');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      if (!res.headersSent) res.writeHead(404).end('Not found');
      else res.end();
    }
  });
  server.once('close', () => db.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createAppServer().listen(Number(process.env.PORT ?? 5173), process.env.HOST ?? '127.0.0.1', () => {
    console.log(`Blink listening on port ${process.env.PORT ?? 5173}`);
  });
}
