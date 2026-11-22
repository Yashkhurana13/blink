import { ApiError, generate, getConfig, getApp, getRawHtml, shareApp, getGallery, type Lane, type Stats, type GenerateBody, type AppSummary } from './api.ts';
import { extractHtml } from './extract.ts';
import { syncRaceLanes } from './lanes.ts';
import { buildPreviewDoc } from './preview.ts';
import { createGeneration, reduceGeneration, generationStatus, buildShareLinks, parseRemixQuery, createGallery, beginGalleryPage, finishGalleryPage, failGalleryPage, type VariantState } from './state.ts';
import './style.css';

const examples = [
  'Neon snake with a rainbow trail',
  'Pomodoro timer with a fox that sleeps',
  'Particle fireworks you click to launch',
  'Breakout with power-ups',
  'Typing-speed test with live WPM',
  'Solar system you can drag to spin',
];

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="header">
    <div class="brand"><span class="brand-mark" aria-hidden="true">↯</span><h1>Blink</h1></div>
    <p class="tagline">Apps at the speed of thought. <span>Kimi K3.1 Pro on Cerebras, via OpenClaw.</span></p>
    <a class="nav-link" href="/gallery">Gallery ↗</a>
    <button id="new" class="quiet-button" type="button" disabled>New <span aria-hidden="true">↗</span></button>
  </header>
  <main>
    <div id="builder">
    <section class="intro" aria-labelledby="headline">
      <p class="eyebrow"><span class="signal" aria-hidden="true"></span> One sentence. A working app.</p>
      <h2 id="headline">Think it.<br class="mobile-break"> <span>Blink it.</span></h2>
      <form id="prompt-form">
        <label class="sr-only" for="prompt">Describe your app</label>
        <div class="prompt-bar">
          <span class="prompt-symbol" aria-hidden="true">↳</span>
          <input id="prompt" name="prompt" type="text" placeholder="What do you want to make?" autocomplete="off" maxlength="500" required>
          <label class="variations-control"><input id="variations" type="checkbox"><span>×4 <span class="variations-word">variations</span></span></label>
          <button id="submit" class="primary-button" type="submit" disabled>Blink <span aria-hidden="true">↗</span></button>
        </div>
      </form>
      <div class="examples" aria-label="Example prompts"></div>
    </section>
    <div class="workspace-heading">
      <p>From idea to interaction<span class="workspace-detail"> / live workspace</span></p>
      <label id="race-control" class="race-control" hidden><input id="race" type="checkbox"><span>Race mode</span><span class="toggle" aria-hidden="true"></span></label>
    </div>
    <div id="lanes" class="lanes"></div>
    <div id="variations-grid" class="variations-grid" aria-label="Four variations" hidden></div>
    <p id="config-message" class="config-message" role="status"></p>
    <div id="load-error" class="load-error" role="alert" hidden><span></span><button type="button" class="quiet-button">Retry</button></div>
    </div>
    <section class="gallery-section" aria-labelledby="gallery-title">
      <div class="gallery-heading"><div><p class="eyebrow">Made with one sentence</p><h2 id="gallery-title">Fresh from the community</h2></div><a id="gallery-link" class="nav-link" href="/gallery">View all ↗</a></div>
      <div id="gallery-grid" class="gallery-grid"></div>
      <p id="gallery-message" class="config-message" role="status"></p>
      <button id="load-more" class="quiet-button" type="button">Load more</button>
    </section>
  </main>
  <div id="toast" class="toast" role="status" hidden></div>
  <footer><span>Built for the moment inspiration hits.</span><span>Powered by OpenClaw <span aria-hidden="true">↗</span></span></footer>
`;

function element<T extends HTMLElement>(selector: string, root: ParentNode = document): T {
  return root.querySelector<T>(selector)!;
}

const form = element<HTMLFormElement>('#prompt-form');
const prompt = element<HTMLInputElement>('#prompt');
const submit = element<HTMLButtonElement>('#submit');
const newButton = element<HTMLButtonElement>('#new');
const race = element<HTMLInputElement>('#race');
const lanesElement = element<HTMLDivElement>('#lanes');
const variations = element<HTMLInputElement>('#variations');
const variationsGrid = element<HTMLDivElement>('#variations-grid');
const galleryOnly = location.pathname === '/gallery';
element('#builder').hidden = galleryOnly;
element('#new').hidden = galleryOnly;
element('#gallery-link').hidden = galleryOnly;
if (galleryOnly) {
  element('#gallery-title').textContent = 'The Blink gallery';
  element('.brand').innerHTML = '<a href="/" aria-label="Blink home"><span class="brand-mark" aria-hidden="true">↯</span><h1>Blink</h1></a>';
}
let choosingVariation = false;
let remixLoading = false;
let lastRun: { idea: string; mode: 'solo' | 'race' | 'variations'; bodies: GenerateBody[] } | null = null;
let toastTimer = 0;
let retryTimer = 0;
let variantsEnabled = true;
function toast(message: string) {
  const root = element('#toast');
  root.textContent = message;
  root.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { root.hidden = true; }, 4000);
}
let controller: AbortController | null = null;
let frame = 0;

function createLane(id: string, label: string, host: HTMLElement = lanesElement) {
  const root = document.createElement('section');
  root.className = `lane lane-${id}`;
  root.setAttribute('aria-label', label);
  root.innerHTML = `
    <div class="lane-heading"><h3></h3><span class="lane-status" role="status">Ready to Blink</span></div>
    <div class="panels">
      <section class="panel code-panel" aria-label="Generated code">
        <div class="panel-heading"><span><span class="panel-icon" aria-hidden="true">&lt;/&gt;</span> Code</span><span class="code-meta">index.html</span></div>
        <pre tabindex="0" aria-label="Generated HTML source"><code></code></pre>
      </section>
      <section class="panel preview-panel" aria-label="App preview">
        <div class="panel-heading"><span><span class="preview-dot" aria-hidden="true"></span> Preview</span><button class="download" type="button" disabled>Download .html <span aria-hidden="true">↓</span></button></div>
        <div class="preview-body">
          <div class="preview-empty"><span class="empty-mark" aria-hidden="true">↯</span><strong>Your next idea lives here.</strong><span>Describe it above. Play it here.</span></div>
          <iframe sandbox="allow-scripts" hidden></iframe>
        </div>
      </section>
    </div>
    <div class="lane-error" role="alert" hidden><span></span><button class="retry quiet-button" type="button">Retry</button></div>
    <div class="stats-bar">
      <div class="stat speed"><div><span data-stat="speed">—</span><span class="stat-unit">tok/s</span></div><span class="stat-label">Generation speed</span></div>
      <div class="stat"><div><span data-stat="total">—</span><span class="stat-unit">s</span></div><span class="stat-label">Total time</span></div>
      <div class="stat"><div><span data-stat="ttft">—</span><span class="stat-unit">ms</span></div><span class="stat-label">First token</span></div>
      <div class="stat"><div><span data-stat="tokens">—</span></div><span class="stat-label token-label">Output tokens</span></div>
      <p class="measurement">measured by Blink<span class="estimate">Waiting for your idea</span></p>
    </div>
    <div class="lane-actions"><button class="share quiet-button" type="button" disabled>Share ↗</button><button class="use-variant primary-button" type="button" hidden>Use this one</button><div class="share-links" hidden><a class="post-x" target="_blank" rel="noopener noreferrer">Post on X ↗</a><a class="open-share" target="_blank" rel="noopener noreferrer">Open ↗</a><input class="share-url" readonly aria-label="Share URL"></div></div>
  `;
  element('h3', root).textContent = label;
  element<HTMLIFrameElement>('iframe', root).title = `${label} app preview`;
  const conversationId: string = crypto.randomUUID();
  const lane = {
    id, root, conversationId, html: '', text: '', error: '', soloRevision: 0,
    appId: null as string | null, phase: 'idle' as VariantState['phase'], position: 0,
    waitingAt: null as number | null, retryable: false, retryAt: 0, sharing: false,
    errorKind: null as 'watchdog' | 'runtime' | 'generation' | null,
    streaming: false, previewSet: false, started: 0, firstDelta: null as number | null,
    previewToken: '', previewTimer: null as number | null, previewReady: false,
    stats: null as Stats | null,
    code: element<HTMLElement>('code', root), pre: element<HTMLPreElement>('pre', root),
    iframe: element<HTMLIFrameElement>('iframe', root),
    status: element<HTMLElement>('.lane-status', root),
    download: element<HTMLButtonElement>('.download', root),
  };
  lane.download.addEventListener('click', () => {
    if (!lane.html) return;
    const url = URL.createObjectURL(new Blob([lane.html], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `blink-${id}.html`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  element('.retry', root).addEventListener('click', () => {
    if (!controller && lastRun && Date.now() >= lane.retryAt) void runGeneration(lastRun);
  });
  element('.share', root).addEventListener('click', () => { void shareLane(lane); });
  element('.use-variant', root).addEventListener('click', () => chooseVariation(lane));
  host.append(root);
  return lane;
}

const cerebras = createLane('cerebras', 'Cerebras · Kimi K3.1 Pro');
const compare = createLane('compare', 'Comparison');
compare.root.hidden = true;
const variantLanes = ['Classic, polished', 'Bold & playful', 'Minimal & elegant', 'Retro / arcade'].map((label, index) => {
  const lane = createLane(`variant-${index}`, label, variationsGrid);
  lane.root.classList.add('mini-lane');
  element('.use-variant', lane.root).hidden = false;
  element('.share', lane.root).hidden = true;
  return lane;
});
const generationLanes = [cerebras, compare, ...variantLanes];
const lanes = [...generationLanes];
type LaneState = typeof cerebras;

function activeLanes() {
  return choosingVariation ? variantLanes : race.checked ? [cerebras, compare] : [cerebras];
}

function updateControls() {
  const busy = controller !== null || remixLoading;
  const remix = !choosingVariation && activeLanes().some(lane => lane.appId);
  prompt.disabled = busy;
  prompt.placeholder = remix ? 'What would you like to change?' : 'What do you want to make?';
  prompt.setAttribute('aria-label', remix ? 'Describe your remix' : 'Describe your app');
  submit.disabled = busy || !prompt.value.trim();
  submit.innerHTML = busy ? 'Blinking<span class="button-pulse" aria-hidden="true">…</span>' : `${remix ? 'Remix' : 'Blink'} <span aria-hidden="true">↗</span>`;
  race.disabled = busy;
  variations.disabled = busy || !variantsEnabled;
  newButton.disabled = !busy && !generationLanes.some(lane => lane.text || lane.html || lane.error);
  document.querySelectorAll<HTMLButtonElement>('.example').forEach(button => { button.disabled = busy; });
  for (const lane of generationLanes) {
    lane.download.disabled = busy || !lane.html || lane.phase !== 'done';
    element<HTMLButtonElement>('.share', lane.root).disabled = busy || !lane.appId || lane.phase !== 'done' || lane.sharing;
    element<HTMLButtonElement>('.use-variant', lane.root).disabled = busy || !lane.html || lane.phase !== 'done';
    const remaining = Math.max(0, Math.ceil((lane.retryAt - Date.now()) / 1000));
    const retry = element<HTMLButtonElement>('.retry', lane.root);
    retry.disabled = busy || remaining > 0;
    retry.textContent = remaining ? `Retry in ${remaining} s` : 'Retry';
  }
}

function renderStats(lane: LaneState) {
  const now = performance.now();
  const elapsed = now - lane.started;
  const tokens = lane.text.length / 4;
  const liveSpeed = lane.firstDelta === null ? 0 : tokens / (Math.max(now - lane.firstDelta, 1) / 1000);
  const values = lane.stats ? {
    speed: lane.stats.tokensPerSecond.toFixed(0), total: (lane.stats.totalMs / 1000).toFixed(2),
    ttft: lane.stats.ttftMs.toFixed(0), tokens: lane.stats.outputTokens.toLocaleString(),
  } : {
    speed: lane.streaming && lane.firstDelta !== null ? liveSpeed.toFixed(0) : '—',
    total: lane.started ? (elapsed / 1000).toFixed(2) : '—',
    ttft: lane.firstDelta === null ? '—' : (lane.firstDelta - lane.started).toFixed(0),
    tokens: lane.text ? Math.round(tokens).toLocaleString() : '—',
  };
  for (const [key, value] of Object.entries(values)) element(`[data-stat="${key}"]`, lane.root).textContent = value;
  element('.estimate', lane.root).textContent = lane.stats
    ? (lane.stats.tokensEstimated ? 'Tokens estimated · chars ÷ 4' : 'Reported output tokens')
    : lane.streaming ? 'Live estimate · chars ÷ 4' : lane.error ? 'Generation interrupted' : 'Waiting for your idea';
  element('.token-label', lane.root).textContent = lane.stats?.tokensEstimated || lane.streaming ? 'Estimated tokens' : 'Output tokens';
}

function renderLane(lane: LaneState) {
  lane.code.textContent = lane.text || '// Your idea becomes a complete HTML app.\n// The code will stream here as it is written.';
  lane.pre.scrollTop = lane.pre.scrollHeight;
  lane.root.classList.toggle('is-streaming', lane.streaming);
  lane.root.setAttribute('aria-busy', String(lane.streaming));
  lane.status.textContent = lane.error ? 'Needs attention' : lane.streaming
    ? generationStatus(lane, lane.position, performance.now()) : lane.html ? 'Ready to play' : 'Ready to Blink';
  const error = element<HTMLElement>('.lane-error', lane.root);
  element('span', error).textContent = lane.error;
  element('.retry', lane.root).hidden = lane.errorKind !== 'generation' || !lane.retryable;
  error.hidden = !lane.error;
  renderStats(lane);
}

function resetPreviewWatch(lane: LaneState) {
  lane.previewToken = '';
  lane.previewReady = false;
  if (lane.previewTimer !== null) window.clearTimeout(lane.previewTimer);
  lane.previewTimer = null;
}

function startPreviewWatch(lane: LaneState) {
  if (document.hidden || !lane.previewToken || lane.previewReady || lane.previewTimer !== null) return;
  const token = lane.previewToken;
  lane.previewTimer = window.setTimeout(() => {
    lane.previewTimer = null;
    if (document.hidden || lane.previewToken !== token || lane.previewReady || lane.error) return;
    lane.error = 'The app didn\'t render. Try Remix: "fix the blank screen"';
    lane.errorKind = 'watchdog';
    renderLane(lane);
  }, 6000);
}

function setPreview(lane: LaneState, html: string) {
  resetPreviewWatch(lane);
  const token = crypto.randomUUID();
  lane.previewToken = token;
  if (lane === cerebras && !race.checked) lane.soloRevision++;
  lane.html = html;
  lane.previewSet = true;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.title = lane.iframe.title;
  iframe.srcdoc = buildPreviewDoc(html, token);
  lane.iframe.replaceWith(iframe);
  lane.iframe = iframe;
  element<HTMLElement>('.preview-empty', lane.root).hidden = true;
  startPreviewWatch(lane);
}

document.addEventListener('visibilitychange', () => {
  for (const lane of lanes) {
    if (document.hidden) {
      if (lane.previewTimer !== null) window.clearTimeout(lane.previewTimer);
      lane.previewTimer = null;
    } else startPreviewWatch(lane);
  }
});

window.addEventListener('message', event => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  const lane = lanes.find(lane => lane.previewToken && data.blinkPreview === lane.previewToken
    && event.source === lane.iframe.contentWindow);
  if (!lane) return;
  if (data.type === 'ready') {
    lane.previewReady = true;
    if (lane.previewTimer !== null) window.clearTimeout(lane.previewTimer);
    lane.previewTimer = null;
    if (lane.errorKind === 'watchdog') {
      lane.error = '';
      lane.errorKind = null;
      renderLane(lane);
    }
  } else if (data.type === 'error' && typeof data.message === 'string') {
    lane.error = `The app hit an error: ${data.message}`;
    lane.errorKind = 'runtime';
    renderLane(lane);
  }
});

function syncRaceContexts() {
  const contexts = syncRaceLanes(cerebras, compare, crypto.randomUUID());
  [cerebras, compare].forEach((lane, index) => {
    const context = contexts[index];
    if (context === lane) return;
    lane.appId = (index === 0 ? compare : cerebras).appId;
    lane.phase = lane.appId ? 'done' : 'idle';
    lane.conversationId = context.conversationId;
    lane.soloRevision = context.soloRevision;
    lane.text = context.html;
    lane.error = '';
    lane.errorKind = null;
    lane.stats = lane.firstDelta = null;
    lane.started = 0;
    setPreview(lane, context.html);
    renderLane(lane);
  });
}

function scheduleRender() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const lane of activeLanes()) if (lane.streaming) renderLane(lane);
  });
}

function chooseVariation(lane: LaneState) {
  if (controller || !lane.html || lane.phase !== 'done') return;
  choosingVariation = false;
  variationsGrid.hidden = true;
  lanesElement.hidden = false;
  variations.checked = false;
  cerebras.text = lane.text;
  cerebras.appId = lane.appId;
  cerebras.stats = lane.stats;
  cerebras.phase = 'done';
  cerebras.error = '';
  cerebras.errorKind = null;
  cerebras.started = lane.started;
  cerebras.firstDelta = lane.firstDelta;
  cerebras.conversationId = lane.conversationId;
  element('.share-links', cerebras.root).hidden = true;
  setPreview(cerebras, lane.html);
  // Stop unused apps after selection; the chosen main preview has its own fresh frame.
  for (const variant of variantLanes) clearLanePreview(variant);
  renderLane(cerebras);
  updateControls();
  prompt.focus();
}

async function shareLane(lane: LaneState) {
  if (!lane.appId || lane.sharing) return;
  const id = lane.appId;
  lane.sharing = true;
  updateControls();
  try {
    const links = buildShareLinks(location.origin, await shareApp(id));
    if (lane.appId !== id) return;
    element<HTMLAnchorElement>('.post-x', lane.root).href = links.x;
    element<HTMLAnchorElement>('.open-share', lane.root).href = links.url;
    const input = element<HTMLInputElement>('.share-url', lane.root);
    input.value = links.url;
    element('.share-links', lane.root).hidden = false;
    try {
      await navigator.clipboard.writeText(links.url);
      toast('Link copied');
    } catch {
      input.focus();
      input.select();
      toast('Link ready. Copy it below.');
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Sharing failed. Please try again.');
  } finally {
    lane.sharing = false;
    updateControls();
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  const idea = prompt.value.trim();
  if (!idea || idea.length > prompt.maxLength || controller || remixLoading) return;
  if (race.checked) syncRaceContexts();
  const mode = race.checked ? 'race' : variations.checked ? 'variations' : 'solo';
  const sources = mode === 'race' ? [cerebras, compare] : [cerebras];
  const bodies: GenerateBody[] = sources.map(lane => ({
    prompt: idea, lane: lane.id as Lane, conversationId: lane.conversationId,
    variants: mode === 'variations' ? 4 : 1,
    ...(lane.appId && !choosingVariation ? { remixOf: lane.appId } : {}),
  }));
  return runGeneration({ idea, mode, bodies });
});

async function runGeneration(request: NonNullable<typeof lastRun>) {
  if (controller || remixLoading) return;
  lastRun = request;
  const run = new AbortController();
  controller = run;
  choosingVariation = request.mode === 'variations';
  race.checked = request.mode === 'race';
  variations.checked = choosingVariation;
  variationsGrid.hidden = !choosingVariation;
  lanesElement.hidden = choosingVariation;
  compare.root.hidden = !race.checked;
  lanesElement.classList.toggle('is-racing', race.checked);
  const started = performance.now();
  const selected = activeLanes();
  for (const lane of selected) {
    clearLanePreview(lane);
    lane.html = lane.text = lane.error = '';
    lane.appId = null;
    lane.phase = 'idle';
    lane.position = 0;
    lane.waitingAt = null;
    lane.retryable = false;
    lane.retryAt = 0;
    lane.errorKind = null;
    lane.stats = null;
    lane.firstDelta = null;
    lane.started = started;
    lane.streaming = true;
    element('.share-links', lane.root).hidden = true;
    renderLane(lane);
  }
  updateControls();
  const timer = window.setInterval(() => {
    for (const lane of selected) if (lane.streaming) renderLane(lane);
    updateControls();
  }, 250);
  let succeeded = false;
  await Promise.all(request.bodies.map(async (body, index) => {
    const targets = choosingVariation ? variantLanes : [selected[index]];
    let state = createGeneration(targets.length);
    try {
      await generate(body, event => {
        if (controller !== run) return;
        state = reduceGeneration(state, event, performance.now());
        targets.forEach((lane, variant) => {
          const next = state.variants[variant];
          lane.position = state.position;
          lane.phase = next.phase;
          lane.waitingAt = next.waitingAt;
          if (event.type === 'queue') { renderLane(lane); return; }
          if (!('variant' in event) || event.variant !== variant) return;
          if (event.type === 'delta') {
            if (event.text && lane.firstDelta === null) lane.firstDelta = performance.now();
            lane.text = next.text;
            if (!lane.previewSet) {
              const html = extractHtml(lane.text);
              if (html !== null) setPreview(lane, html);
            }
            scheduleRender();
          } else if (event.type === 'status') {
            renderLane(lane);
          } else {
            lane.streaming = false;
            if (event.type === 'error') {
              lane.error = next.error;
              lane.errorKind = 'generation';
              lane.retryable = next.retryable;
            } else {
              lane.stats = next.stats;
              lane.appId = next.appId;
              const html = extractHtml(lane.text);
              if (html === null) {
                lane.error = 'No complete HTML app was returned. Please try again.';
                lane.errorKind = 'generation';
                lane.retryable = true;
                lane.phase = 'error';
                lane.appId = null;
              } else {
                if (html !== lane.html) setPreview(lane, html);
                succeeded = true;
              }
            }
            renderLane(lane);
          }
        });
      }, run.signal);
    } catch (error) {
      if (controller !== run) return;
      for (const lane of targets) {
        // A lost connection must not discard variants which already finished.
        if (lane.phase === 'done' || lane.phase === 'error') continue;
        lane.error = error instanceof Error ? error.message : 'Generation failed. Please try again.';
        lane.errorKind = 'generation';
        lane.phase = 'error';
        lane.retryable = !(error instanceof ApiError) || error.retryable;
        lane.retryAt = Date.now() + (error instanceof ApiError ? error.retryAfterSec * 1000 : 0);
      }
    } finally {
      if (controller === run) for (const lane of targets) {
        lane.streaming = false;
        renderLane(lane);
      }
    }
  }));
  clearInterval(timer);
  if (controller !== run) return;
  controller = null;
  if (succeeded) prompt.value = '';
  window.clearInterval(retryTimer);
  if (selected.some(lane => lane.retryAt > Date.now())) retryTimer = window.setInterval(() => {
    updateControls();
    if (selected.every(lane => lane.retryAt <= Date.now())) window.clearInterval(retryTimer);
  }, 1000);
  updateControls();
  prompt.focus();
}

function clearLanePreview(lane: LaneState) {
  resetPreviewWatch(lane);
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.title = lane.iframe.title;
  iframe.hidden = true;
  lane.iframe.replaceWith(iframe);
  lane.iframe = iframe;
  lane.previewSet = false;
  element<HTMLElement>('.preview-empty', lane.root).hidden = false;
}

newButton.addEventListener('click', () => {
  controller?.abort();
  controller = null;
  remixLoading = false;
  window.clearInterval(retryTimer);
  lastRun = null;
  choosingVariation = false;
  variationsGrid.hidden = true;
  lanesElement.hidden = false;
  element('#load-error').hidden = true;
  history.replaceState(null, '', location.pathname);
  for (const lane of generationLanes) {
    clearLanePreview(lane);
    lane.appId = null;
    lane.phase = 'idle';
    lane.retryable = false;
    lane.conversationId = crypto.randomUUID();
    lane.html = lane.text = lane.error = '';
    lane.errorKind = null;
    lane.soloRevision = 0;
    lane.streaming = lane.previewSet = false;
    lane.stats = lane.firstDelta = null;
    lane.started = 0;
    element('.share-links', lane.root).hidden = true;
    renderLane(lane);
  }
  prompt.value = '';
  updateControls();
  prompt.focus();
});

for (const example of examples) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'example';
  button.textContent = example;
  button.addEventListener('click', () => {
    prompt.value = example;
    updateControls();
    prompt.focus();
  });
  element('.examples').append(button);
}

prompt.addEventListener('input', updateControls);
race.addEventListener('change', () => {
  if (race.checked) {
    variations.checked = false;
    choosingVariation = false;
    variationsGrid.hidden = true;
    lanesElement.hidden = false;
    syncRaceContexts();
  }
  compare.root.hidden = !race.checked;
  lanesElement.classList.toggle('is-racing', race.checked);
  updateControls();
});

variations.addEventListener('change', () => {
  if (variations.checked) {
    race.checked = false;
    compare.root.hidden = true;
    lanesElement.classList.toggle('is-racing', false);
  }
  updateControls();
});

for (const lane of generationLanes) renderLane(lane);
getConfig().then(config => {
  variantsEnabled = config.variantsEnabled;
  variations.disabled = !variantsEnabled;
  element('.variations-control').hidden = !config.variantsEnabled;
  prompt.maxLength = Math.min(500, config.maxPromptChars);
  if (!config.compareEnabled) return;
  element('#race-control').hidden = false;
  const label = config.compareLabel || 'Comparison';
  element('h3', compare.root).textContent = label;
  compare.root.setAttribute('aria-label', label);
  compare.iframe.title = `${label} app preview`;
}).catch(() => {
  element('#config-message').textContent = 'Race availability could not be loaded. You can still Blink an app.';
});

async function loadRemix(id: string) {
  const run = new AbortController();
  controller?.abort();
  controller = run;
  remixLoading = true;
  element('#load-error').hidden = true;
  cerebras.status.textContent = 'Loading your remix…';
  updateControls();
  try {
    const [app, html] = await Promise.all([getApp(id, run.signal), getRawHtml(id, run.signal)]);
    if (controller !== run) return;
    if (extractHtml(html) === null) throw new Error('This app has no complete preview. Try another app.');
    cerebras.appId = app.id;
    cerebras.text = html;
    cerebras.phase = 'done';
    cerebras.error = '';
    cerebras.errorKind = null;
    setPreview(cerebras, html);
    renderLane(cerebras);
    prompt.value = '';
    prompt.focus();
  } catch (error) {
    if (controller !== run) return;
    element('span', element('#load-error')).textContent = error instanceof Error ? error.message : 'This app couldn’t be loaded. Please try again.';
    element('#load-error').hidden = false;
    cerebras.status.textContent = 'Couldn’t load this app';
  } finally {
    if (controller === run) {
      controller = null;
      remixLoading = false;
      updateControls();
      prompt.focus();
    }
  }
}

const remixId = parseRemixQuery(location.search);
element('button', element('#load-error')).addEventListener('click', () => { if (remixId) void loadRemix(remixId); });
if (remixId && !galleryOnly) void loadRemix(remixId);

let gallery = createGallery();
const galleryGrid = element('#gallery-grid');
const loadMore = element<HTMLButtonElement>('#load-more');

function galleryCard(app: AppSummary) {
  const card = document.createElement('article');
  card.className = 'gallery-card';
  card.innerHTML = `<div class="gallery-preview"><button class="preview-trigger" type="button">↯ <span>Try live preview</span></button></div><div class="gallery-copy"><h3></h3><p></p><a target="_blank" rel="noopener noreferrer">Open app ↗</a></div>`;
  element('h3', card).textContent = app.title || 'Untitled app';
  element('p', card).textContent = app.prompt;
  element<HTMLAnchorElement>('a', card).href = `/a/${encodeURIComponent(app.id)}`;
  const trigger = element<HTMLButtonElement>('.preview-trigger', card);
  trigger.setAttribute('aria-label', `Try live preview of ${app.title || 'Untitled app'}`);
  let loading = false;
  let preview: LaneState | null = null;
  const showPreview = async () => {
    if (loading || preview) return;
    loading = true;
    trigger.textContent = 'Loading preview…';
    try {
      const html = await getRawHtml(app.id);
      if (extractHtml(html) === null) throw new Error('Preview unavailable');
      // Only create the frame after hover, keyboard focus, or an explicit tap.
      preview = createLane(`gallery-${app.id}`, app.title, element('.gallery-preview', card));
      preview.root.classList.add('gallery-mini');
      preview.text = html;
      preview.phase = 'done';
      lanes.push(preview);
      setPreview(preview, html);
      renderLane(preview);
      trigger.hidden = true;
    } catch {
      trigger.textContent = 'Preview unavailable · Tap to retry';
    } finally {
      loading = false;
    }
  };
  trigger.addEventListener('pointerenter', () => { void showPreview(); });
  trigger.addEventListener('focus', () => { void showPreview(); });
  trigger.addEventListener('click', () => { void showPreview(); });
  return card;
}

function renderGalleryState() {
  loadMore.disabled = gallery.loading;
  loadMore.hidden = gallery.loaded && gallery.nextCursor === null && !gallery.error;
  loadMore.textContent = gallery.loading ? 'Loading…' : gallery.error ? 'Retry' : 'Load more';
  element('#gallery-message').textContent = gallery.error || (gallery.loading ? 'Loading community apps…' :
    gallery.loaded && !gallery.items.length ? 'The gallery is waiting for its first app. Make something and share it.' : '');
}

async function loadGalleryPage() {
  const next = beginGalleryPage(gallery);
  if (next === gallery) return;
  gallery = next;
  renderGalleryState();
  try {
    const page = await getGallery(gallery.nextCursor);
    const count = gallery.items.length;
    gallery = finishGalleryPage(gallery, page);
    for (const app of gallery.items.slice(count)) galleryGrid.append(galleryCard(app));
  } catch (error) {
    gallery = failGalleryPage(gallery, error instanceof Error ? error.message : 'The gallery couldn’t be loaded. Please try again.');
  }
  renderGalleryState();
}
loadMore.addEventListener('click', () => { void loadGalleryPage(); });
void loadGalleryPage();
