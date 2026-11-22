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
    const ready = () => parent.postMessage({ blinkPreview: token, type: 'ready' }, '*');
    window.addEventListener('DOMContentLoaded', ready);
    window.addEventListener('load', () => {
      ready();
      window.requestAnimationFrame(ready);
    });
  })();</script>`;
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">`;
  const head = /<head\b[^>]*>/i.exec(html);
  const opening = head ?? /<html\b[^>]*>/i.exec(html);
  const index = opening ? opening.index + opening[0].length : 0;
  const bootstrap = policy + script;
  return html.slice(0, index) + (head ? bootstrap : `<head>${bootstrap}</head>`) + html.slice(index);
}
