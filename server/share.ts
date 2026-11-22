import type { SavedApp } from './db.ts';

export const RAW_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:";

function escapeHtml(text: string) {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return text.replace(/[&<>"']/g, char => entities[char]);
}

export function sharePage(app: SavedApp, origin: string) {
  const title = escapeHtml(app.title);
  const prompt = escapeHtml(app.prompt);
  const url = escapeHtml(new URL(`/a/${app.id}`, origin).href);
  const image = escapeHtml(new URL('/og.png', origin).href);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Blink</title><meta name="description" content="${prompt}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Blink">
<meta property="og:title" content="${title}"><meta property="og:description" content="${prompt}">
<meta property="og:url" content="${url}"><meta property="og:image" content="${image}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${prompt}"><meta name="twitter:image" content="${image}">
<style>*{box-sizing:border-box}body{margin:0;background:#101016;color:#f4f4fa;font:16px system-ui,sans-serif}header,main{max-width:1200px;margin:auto;padding:20px}header{display:flex;align-items:center;justify-content:space-between;gap:16px}a{color:inherit;text-decoration:none}.logo{font-size:24px;font-weight:800}h1{font-size:24px;margin:0 0 8px}p{overflow-wrap:anywhere;color:#c6c6d6}iframe{display:block;width:100%;height:75vh;border:0;border-radius:12px;background:white}.actions{display:flex;align-items:center;gap:20px;margin:20px 0}button{font:inherit;color:inherit;background:none;border:1px solid #555;border-radius:8px;padding:8px 16px;cursor:pointer}</style>
</head><body><header><a class="logo" href="/" aria-label="Blink home">⚡ Blink</a><a href="/">Make your own</a></header>
<main><h1>${title}</h1><p>${prompt}</p><iframe title="App preview" sandbox="allow-scripts" src="/raw/${app.id}"></iframe>
<div class="actions"><a href="/?remix=${app.id}">Remix this</a><button id="report" type="button">Report</button><span id="report-status" role="status"></span></div></main>
<script>document.getElementById('report').addEventListener('click',async function(){this.disabled=true;const status=document.getElementById('report-status');try{const response=await fetch('/api/apps/${app.id}/report',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw new Error();status.textContent='Report received. Thank you.';}catch{status.textContent='Could not report. Please try again.';this.disabled=false;}});</script>
</body></html>`;
}
