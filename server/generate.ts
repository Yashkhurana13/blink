import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { UpstreamBudget } from './budget.ts';
import { AppDatabase, type SavedApp } from './db.ts';
import { extractHtml, extractTitle } from './extract.ts';
import { buildLaneRequest, getConfig, type GenerateRequest } from './lanes.ts';
import { Scheduler } from './queue.ts';
import { parseCompletion, parseSse } from './sse.ts';
import { createStatsTracker } from './stats.ts';

export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function canRead(app: SavedApp, creatorHash: string) {
  return app.creatorHash === creatorHash || (app.shared && !app.hidden);
}

function validInput(body: unknown): body is GenerateRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const input = body as Record<string, unknown>;
  return typeof input.prompt === 'string' && input.prompt.trim().length > 0 && input.prompt.length <= 500
    && (input.lane === undefined || input.lane === 'cerebras' || input.lane === 'compare')
    && (input.variants === undefined || input.variants === 1 || input.variants === 4)
    && !(input.lane === 'compare' && input.variants === 4)
    && (input.remixOf === undefined || (typeof input.remixOf === 'string' && /^[A-Za-z0-9_-]{10}$/.test(input.remixOf)))
    && input.currentHtml === undefined
    && (input.runId === undefined || (typeof input.runId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(input.runId)))
    && (input.conversationId === undefined || typeof input.conversationId === 'string');
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
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

const directions = ['classic, polished', 'bold, playful, surprising', 'minimal and elegant', 'retro / arcade'];
class UpstreamError extends Error {
  constructor(readonly retryable: boolean, readonly paused = false) { super('Upstream request failed'); }
}

export async function generate(
  req: IncomingMessage, res: ServerResponse, env: NodeJS.ProcessEnv,
  db: AppDatabase, scheduler: Scheduler, ipHash: string, creatorHash: string, budget: UpstreamBudget,
) {
  let input: unknown;
  try { input = await readBody(req); }
  catch {
    if (!res.destroyed) json(res, 400, { error: 'Invalid request body' });
    return;
  }
  if (!validInput(input) || (input.lane === 'compare' && !getConfig(env).compareEnabled)) {
    json(res, 400, { error: 'Invalid prompt, variants, remixOf, lane, conversationId, or runId' });
    return;
  }
  const parent = input.remixOf ? db.get(input.remixOf) : undefined;
  if (input.remixOf && (!parent || !canRead(parent, creatorHash) || Buffer.byteLength(parent.html) > 200_000)) {
    json(res, 400, { error: 'App unavailable for remix' });
    return;
  }
  // Count the parent itself as level one; bound traversal even for malformed cycles.
  let parentDepth = 0;
  for (let ancestor = parent; ancestor && parentDepth < 8; ancestor = ancestor.parentId ? db.get(ancestor.parentId) : undefined) {
    parentDepth++;
  }
  if (res.destroyed) return;
  const race = getConfig(env).compareEnabled && input.lane && (input.variants ?? 1) === 1 ? {
    // Older clients omit runId; pair those by prompt without coupling the lanes' remix parents.
    lane: input.lane, key: input.runId === undefined
      ? `prompt:${createHash('sha256').update(input.prompt).digest('hex')}` : `run:${input.runId}`,
  } : undefined;
  const job = scheduler.reserve(ipHash, input.variants ?? 1, race);
  if ('error' in job) {
    res.setHeader('Retry-After', job.retryAfterSec);
    json(res, job.error === 'busy' ? 503 : 429, job);
    return;
  }
  const controller = new AbortController();
  let started = false;
  const disconnect = () => {
    controller.abort();
    if (!started) job.release();
  };
  res.on('close', disconnect);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (event: unknown) => {
    if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  job.onPosition(position => send({ type: 'queue', position }));
  try {
    await job.ready;
    if (controller.signal.aborted) return;
    started = true;
    const request = { ...input, conversationId: parentDepth >= 8 ? randomUUID() : input.conversationId ?? randomUUID(), currentHtml: parent?.html };
    await Promise.all(Array.from({ length: input.variants ?? 1 }, async (_, variant) => {
      const tracker = createStatsTracker();
      const upstreamController = new AbortController();
      const abort = () => upstreamController.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      let timedOut = false;
      let firstToken = false;
      let text = '';
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const upstream = await buildLaneRequest({
          ...request, prompt: `${request.prompt}\n\nCreative direction: ${directions[variant]}.`,
          conversationId: input.variants === 4 ? `${request.conversationId}:v${variant}` : request.conversationId,
        }, env);
        for (let attempt = 0; ; attempt++) {
          let reconcile: ((actualTokens: number) => void) | undefined;
          let actualTokens: number | undefined;
          try {
            upstreamController.signal.throwIfAborted();
            reconcile = await budget.acquire(upstream.estimatedTokens, upstreamController.signal,
              position => send({ type: 'queue', position }));
            upstreamController.signal.throwIfAborted();
            // Time spent waiting for shared quota or backoff is not an upstream timeout.
            timeout = setTimeout(() => { timedOut = true; upstreamController.abort(); }, 360_000);
            timeout.unref?.();
            send({ type: 'status', variant, phase: 'waiting_model' });
            const response = await fetch(upstream.url, {
              method: 'POST', headers: upstream.headers, body: upstream.body, signal: upstreamController.signal,
            });
            if (!response.ok || !response.body) {
              if (response.status === 429) budget.pause(response.headers.get('Retry-After'));
              await response.body?.cancel();
              throw new UpstreamError(response.status === 429 || response.status >= 500, [401, 402, 403, 429].includes(response.status));
            }
            const events = response.headers.get('content-type')?.split(';', 1)[0].trim() === 'application/json'
              ? parseCompletion(await response.text()) : parseSse(Readable.fromWeb(response.body), true);
            for await (const event of events) {
              if (event.type === 'delta') {
                firstToken = true;
                text += event.text;
                tracker.recordDelta(event.text);
                send({ ...event, variant });
              } else {
                tracker.setUsage(event.completionTokens);
                if (event.promptTokens !== undefined) actualTokens = event.promptTokens + event.completionTokens;
              }
            }
            break;
          } catch (error) {
            const retryable = error instanceof UpstreamError ? error.retryable : error instanceof TypeError
              || (error instanceof Error && !['SyntaxError', 'Error'].includes(error.name));
            // Fetch transport failures are TypeError; readable transport failures carry a code.
            const networkError = retryable || Boolean((error as NodeJS.ErrnoException)?.code);
            if (attempt === 0 && !firstToken && !upstreamController.signal.aborted && networkError) continue;
            if (!(error instanceof UpstreamError) && networkError) throw new UpstreamError(true);
            throw error;
          } finally {
            clearTimeout(timeout);
            if (actualTokens !== undefined) reconcile?.(actualTokens);
          }
        }
        if (!controller.signal.aborted) {
          const html = extractHtml(text);
          const appId = html ? db.save({
            title: extractTitle(html), prompt: request.prompt, html, ipHash, creatorHash, parentId: request.remixOf ?? null,
          }).id : null;
          send({ type: 'done', variant, stats: tracker.finish(), appId });
        }
      } catch (error) {
        if (!controller.signal.aborted) send({
          type: 'error', variant,
          message: firstToken ? 'That app came out too long. Try a simpler idea, or build it up with remixes.'
            : timedOut ? 'Generation timed out.' : error instanceof UpstreamError && error.paused
            ? 'Blink is paused or busy. Please try again shortly.' : 'Upstream request failed. Please try again.',
          retryable: firstToken || timedOut || (error instanceof UpstreamError && error.retryable),
        });
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener('abort', abort);
        upstreamController.abort();
      }
    }));
    if (!controller.signal.aborted) send({ type: 'end' });
  } finally {
    res.off('close', disconnect);
    controller.abort();
    job.release();
    res.end();
  }
}
