export function buildPreviewDoc(html: string, token: string): string {
  const script = `<script>(() => {
    const token = ${JSON.stringify(token).replace(/</g, '\\u003c')};
    for (const name of ['localStorage', 'sessionStorage']) {
      const items = new Map();
      try {
        Object.defineProperty(window, name, { configurable: true, value: {
          getItem(key) { return items.get(String(key)) ?? null; },
          setItem(key, value) { items.set(String(key), String(value)); },
          removeItem(key) { items.delete(String(key)); },
          clear() { items.clear(); },
          key(index) { return Array.from(items.keys())[index] ?? null; },
          get length() { return items.size; }
        } });
      } catch {}
    }
    window.alert = () => {};
    window.confirm = () => false;
    window.prompt = () => null;
    window.addEventListener('error', event => {
      parent.postMessage({ blinkPreview: token, type: 'error', message: event.message || 'Unknown error' }, '*');
    });
    window.addEventListener('unhandledrejection', event => {
      parent.postMessage({ blinkPreview: token, type: 'error', message: String(event.reason?.message ?? event.reason) }, '*');
    });
    window.addEventListener('load', () => {
      window.requestAnimationFrame(() => parent.postMessage({ blinkPreview: token, type: 'ready' }, '*'));
    });
  })();</script>`;
  const opening = /<head\b[^>]*>/i.exec(html) ?? /<html\b[^>]*>/i.exec(html);
  const index = opening ? opening.index + opening[0].length : 0;
  return html.slice(0, index) + script + html.slice(index);
}
