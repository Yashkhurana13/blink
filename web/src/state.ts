import type { AppSummary, GalleryPage, GenerateEvent, Stats } from './api.ts';

export interface VariantState {
  text: string;
  phase: 'idle' | 'queued' | 'waiting_model' | 'streaming' | 'done' | 'error' | 'stopped';
  waitingAt: number | null;
  stats: Stats | null;
  appId: string | null;
  error: string;
  retryable: boolean;
}
export interface GenerationState { position: number; ended: boolean; variants: VariantState[] }

export function createGeneration(count: number): GenerationState {
  return { position: 0, ended: false, variants: Array.from({ length: count }, () => ({
    text: '', phase: 'idle', waitingAt: null, stats: null, appId: null, error: '', retryable: false,
  })) };
}

export function reduceGeneration(state: GenerationState, event: GenerateEvent, now: number): GenerationState {
  if (state.ended) return state;
  if (event.type === 'end') return { ...state, ended: true };
  if (event.type === 'queue') return { ...state, position: event.position, variants: state.variants.map(variant =>
    variant.phase === 'done' || variant.phase === 'error' ? variant : {
      ...variant, phase: event.position > 0 ? 'queued' : 'idle', waitingAt: null,
    }) };
  return { ...state, variants: state.variants.map((variant, index) => {
    if (index !== event.variant || variant.phase === 'done' || variant.phase === 'error') return variant;
    switch (event.type) {
      case 'status': return { ...variant, phase: event.phase, waitingAt: variant.waitingAt ?? now };
      case 'delta': return { ...variant, phase: 'streaming', text: variant.text + event.text };
      case 'done': return { ...variant, phase: 'done', stats: event.stats, appId: event.appId };
      case 'error': return { ...variant, phase: 'error', error: event.message, retryable: event.retryable };
    }
  }) };
}

export function generationStatus(variant: VariantState, position: number, now: number): string {
  if (variant.phase === 'queued') return `You're #${position} in line`;
  if (variant.phase === 'waiting_model') return `Waiting for the model · ${Math.max(0, Math.floor((now - (variant.waitingAt ?? now)) / 1000))} s`;
  if (variant.phase === 'stopped') return 'Stopped';
  if (variant.phase === 'streaming') return 'Streaming';
  if (variant.phase === 'done') return 'Ready to play';
  if (variant.phase === 'error') return 'Needs attention';
  return 'Connecting to Blink…';
}

export function buildShareLinks(origin: string, path: string): { url: string; x: string } {
  if (!/^\/a\/[\w-]+$/.test(path)) throw new Error('Sharing returned an invalid link. Please try again.');
  const url = new URL(path, origin).href;
  const query = new URLSearchParams({ text: 'I made this with one sentence on Blink ⚡', url });
  return { url, x: `https://twitter.com/intent/tweet?${query}` };
}

export function parseRemixQuery(search: string): string | null {
  const id = new URLSearchParams(search).get('remix');
  return id && /^[\w-]{1,128}$/.test(id) ? id : null;
}

export interface GalleryState {
  items: AppSummary[];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  error: string;
}
export function createGallery(): GalleryState {
  return { items: [], nextCursor: null, loaded: false, loading: false, error: '' };
}
export function beginGalleryPage(state: GalleryState): GalleryState {
  if (state.loading || (state.loaded && state.nextCursor === null)) return state;
  return { ...state, loading: true, error: '' };
}
export function finishGalleryPage(state: GalleryState, page: GalleryPage): GalleryState {
  const ids = new Set(state.items.map(item => item.id));
  const items = [...state.items];
  for (const item of page.items) if (!ids.has(item.id)) { ids.add(item.id); items.push(item); }
  return { items, nextCursor: page.nextCursor, loaded: true, loading: false, error: '' };
}
export function failGalleryPage(state: GalleryState, error: string): GalleryState {
  return { ...state, loading: false, error };
}
