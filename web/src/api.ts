export type Lane = 'cerebras' | 'compare';

export interface GenerateBody {
  prompt: string;
  conversationId?: string;
  currentHtml?: string;
  lane: Lane;
}

export interface Stats {
  ttftMs: number;
  totalMs: number;
  outputTokens: number;
  tokensPerSecond: number;
  tokensEstimated: boolean;
}

export type GenerateEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; stats: Stats }
  | { type: 'error'; message: string };

export interface Config {
  compareEnabled: boolean;
  compareLabel: string | null;
}

function parseEvent(data: string): GenerateEvent {
  const event = JSON.parse(data);
  if (event && (
    (event.type === 'delta' && typeof event.text === 'string') ||
    (event.type === 'error' && typeof event.message === 'string') ||
    (event.type === 'done' && event.stats &&
      ['ttftMs', 'totalMs', 'outputTokens', 'tokensPerSecond'].every(key =>
        typeof event.stats[key] === 'number' && Number.isFinite(event.stats[key])) &&
      typeof event.stats.tokensEstimated === 'boolean')
  )) return event;
  throw new Error('Invalid generation event. Please try again.');
}

export async function generate(
  body: GenerateBody,
  onEvent: (event: GenerateEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`Generation failed (${response.status}). Please try again.`);
  if (!response.body) throw new Error('Generation stream is unavailable. Please try again.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (line: string): boolean => {
    if (!line.startsWith('data:')) return false;
    const data = line.slice(5).trim();
    if (!data) return false;
    let event: GenerateEvent;
    try { event = parseEvent(data); }
    catch { throw new Error('Invalid generation event. Please try again.'); }
    onEvent(event);
    return event.type !== 'delta';
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
        throw new Error('Generation ended before completion. Please try again.');
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function getConfig(): Promise<Config> {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error(`Configuration unavailable (${response.status}).`);
  const config = await response.json();
  if (!config || typeof config.compareEnabled !== 'boolean' ||
      !(config.compareLabel === null || typeof config.compareLabel === 'string')) {
    throw new Error('Invalid configuration.');
  }
  return config;
}
