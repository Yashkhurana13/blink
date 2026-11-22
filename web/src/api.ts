export type Lane = 'cerebras' | 'compare';

export interface GenerateBody {
  prompt: string;
  variants?: 1 | 4;
  remixOf?: string;
  runId?: string;
  conversationId?: string;
  lane?: Lane;
}

export interface Stats {
  ttftMs: number;
  totalMs: number;
  outputTokens: number;
  tokensPerSecond: number;
  tokensEstimated: boolean;
}

export type GenerateEvent =
  | { type: 'queue'; position: number }
  | { type: 'status'; variant: number; phase: 'waiting_model' }
  | { type: 'delta'; variant: number; text: string }
  | { type: 'done'; variant: number; stats: Stats; appId: string | null }
  | { type: 'error'; variant: number; message: string; retryable: boolean }
  | { type: 'end' };

export interface Config {
  modelLabel: string;
  compareEnabled: boolean;
  compareLabel: string | null;
  variantsEnabled: boolean;
  maxPromptChars: number;
  publicOrigin: string | null;
}

export interface AppSummary {
  id: string;
  title: string;
  prompt: string;
  createdAt: number;
}
export interface SavedApp extends AppSummary {
  shared: boolean;
  parentId: string | null;
}
export interface GalleryPage { items: AppSummary[]; nextCursor: string | null }

export class ApiError extends Error {
  constructor(message: string, public retryable = true, public retryAfterSec = 0) {
    super(message);
  }
}

async function checkResponse(response: Response): Promise<void> {
  if (response.ok) return;
  if (response.status === 429 || response.status === 503) {
    const body = await response.json().catch(() => ({}));
    const retryAfterSec = typeof body.retryAfterSec === 'number' && Number.isFinite(body.retryAfterSec)
      ? Math.max(0, Math.ceil(body.retryAfterSec)) : 0;
    const message = response.status === 503
      ? 'Blink is very busy. Please try again shortly.'
      : 'You’ve reached Blink’s limit or already have an app in progress. Please try again shortly.';
    throw new ApiError(message + (retryAfterSec ? ` Try again in ${retryAfterSec} s.` : ''), true, retryAfterSec);
  }
  throw new ApiError(`That request couldn’t be completed (${response.status}). Please try again.`, response.status >= 500);
}

function parseEvent(data: string): GenerateEvent {
  const event = JSON.parse(data);
  if (event?.type === 'end') return event;
  if (event?.type === 'queue' && Number.isInteger(event.position) && event.position >= 0) return event;
  if (event && Number.isInteger(event.variant) && event.variant >= 0 && event.variant < 4 && (
    (event.type === 'status' && event.phase === 'waiting_model') ||
    (event.type === 'delta' && typeof event.text === 'string') ||
    (event.type === 'error' && typeof event.message === 'string' && typeof event.retryable === 'boolean') ||
    (event.type === 'done' && (event.appId === null || typeof event.appId === 'string') && event.stats &&
      ['ttftMs', 'totalMs', 'outputTokens', 'tokensPerSecond'].every(key =>
        typeof event.stats[key] === 'number' && Number.isFinite(event.stats[key])) &&
      typeof event.stats.tokensEstimated === 'boolean')
  )) return event;
  throw new ApiError('Invalid generation event. Please try again.');
}

export async function generate(
  body: GenerateBody,
  onEvent: (event: GenerateEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body), signal,
  });
  await checkResponse(response);
  if (!response.body) throw new ApiError('Generation stream is unavailable. Please try again.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const completed = new Set<number>();
  const count = body.variants ?? 1;
  let buffer = '';
  const consume = (line: string): boolean => {
    if (!line.startsWith('data:')) return false;
    const data = line.slice(5).trim();
    if (!data) return false;
    let event: GenerateEvent;
    try { event = parseEvent(data); }
    catch { throw new ApiError('Invalid generation event. Please try again.'); }
    if ('variant' in event && event.variant >= count) throw new ApiError('Invalid generation variant. Please try again.');
    if (event.type === 'done' || event.type === 'error') completed.add(event.variant);
    if (event.type === 'end' && completed.size !== count) throw new ApiError('Generation ended before completion. Please try again.');
    onEvent(event);
    return event.type === 'end';
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (consume(line)) return;
      }
      if (done) {
        if (consume(buffer)) return;
        throw new ApiError('Generation ended before completion. Please try again.');
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function getConfig(): Promise<Config> {
  const response = await fetch('/api/config');
  await checkResponse(response);
  const config = await response.json();
  if (!config || typeof config.modelLabel !== 'string' || typeof config.compareEnabled !== 'boolean' ||
      !(config.compareLabel === null || typeof config.compareLabel === 'string') ||
      typeof config.variantsEnabled !== 'boolean' || !Number.isInteger(config.maxPromptChars) || config.maxPromptChars < 1 ||
      !(config.publicOrigin === null || typeof config.publicOrigin === 'string')) {
    throw new Error('Invalid configuration.');
  }
  return config;
}

export async function getApp(id: string, signal?: AbortSignal): Promise<SavedApp> {
  const response = await fetch(`/api/apps/${encodeURIComponent(id)}`, { signal });
  await checkResponse(response);
  return response.json();
}

export async function getRawHtml(id: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`/raw/${encodeURIComponent(id)}`, { signal });
  await checkResponse(response);
  return response.text();
}

export async function shareApp(id: string): Promise<string> {
  const response = await fetch(`/api/apps/${encodeURIComponent(id)}/share`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  await checkResponse(response);
  const body = await response.json();
  if (typeof body?.url !== 'string') throw new Error('Sharing returned an invalid link. Please try again.');
  return body.url;
}

export async function getGallery(cursor: string | null = null): Promise<GalleryPage> {
  const query = new URLSearchParams({ limit: '24' });
  if (cursor !== null) query.set('cursor', cursor);
  const response = await fetch(`/api/gallery?${query}`);
  await checkResponse(response);
  const page = await response.json();
  if (!Array.isArray(page?.items) || !(page.nextCursor === null || typeof page.nextCursor === 'string') ||
      !page.items.every((item: AppSummary) => item && ['id', 'title', 'prompt'].every(key =>
        typeof item[key as keyof AppSummary] === 'string') && typeof item.createdAt === 'number')) {
    throw new Error('The gallery couldn’t be loaded. Please try again.');
  }
  return page;
}
