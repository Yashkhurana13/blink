import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildLaneRequest, getConfig, type GenerateRequest } from './lanes.ts';
import { parseSse } from './sse.ts';
import { createStatsTracker } from './stats.ts';

const webRoot = fileURLToPath(new URL('../dist/web/', import.meta.url));
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function validInput(body: unknown): body is GenerateRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const input = body as Record<string, unknown>;
  return typeof input.prompt === 'string' && input.prompt.trim().length > 0 && input.prompt.length <= 4000
    && (input.lane === 'cerebras' || input.lane === 'compare')
    && (input.currentHtml === undefined || (typeof input.currentHtml === 'string' && input.currentHtml.length <= 200000))
    && (input.conversationId === undefined || typeof input.conversationId === 'string');
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Keep the response writable when rejecting an oversized request.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 2_000_000) {
      req.resume();
      throw new Error('Request too large');
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function generate(req: IncomingMessage, res: ServerResponse, env: NodeJS.ProcessEnv) {
  const tracker = createStatsTracker();
  let input: unknown;
  try {
    input = await readBody(req);
  } catch {
    if (!res.destroyed) json(res, 400, { error: 'Invalid request body' });
    return;
  }
  if (!validInput(input) || (input.lane === 'compare' && !getConfig(env).compareEnabled)) {
    json(res, 400, { error: 'Invalid prompt, lane, currentHtml, or conversationId' });
    return;
  }
  if (res.destroyed) return;

  const controller = new AbortController();
  const disconnect = () => controller.abort();
  res.on('close', disconnect);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 180_000);
  timeout.unref();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  const send = (event: unknown) => {
    if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  try {
    const upstream = await buildLaneRequest({ ...input, conversationId: input.conversationId ?? randomUUID() }, env);
    const response = await fetch(upstream.url, {
      method: 'POST', headers: upstream.headers, body: upstream.body, signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error('Upstream request failed');
    for await (const event of parseSse(Readable.fromWeb(response.body))) {
      if (event.type === 'delta') {
        tracker.recordDelta(event.text);
        send(event);
      } else {
        tracker.setUsage(event.completionTokens);
      }
    }
    send({ type: 'done', stats: tracker.finish() });
  } catch {
    send({ type: 'error', message: timedOut ? 'Generation timed out.' : 'Upstream request failed.' });
  } finally {
    clearTimeout(timeout);
    res.off('close', disconnect);
    controller.abort();
    res.end();
  }
}

export function createAppServer(env: NodeJS.ProcessEnv = process.env) {
  return createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      if ((pathname === '/api' || pathname.startsWith('/api/')) && req.method !== 'GET') {
        if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          json(res, 415, { error: 'Content-Type must be application/json' });
          return;
        }
        const allowedOrigins = [
          `http://${req.headers.host}`,
          'http://127.0.0.1:5173',
          'http://localhost:5173',
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
        await generate(req, res, env);
        return;
      }
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        json(res, 404, { error: 'Not found' });
        return;
      }

      const file = resolve(webRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(resolve(webRoot) + sep)) {
        res.writeHead(404).end('Not found');
        return;
      }

      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createAppServer().listen(Number(process.env.PORT ?? 5173), process.env.HOST ?? '127.0.0.1', () => {
    console.log(`Blink listening on port ${process.env.PORT ?? 5173}`);
  });
}
