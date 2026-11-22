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
  <svg class="svg-defs" width="0" height="0" aria-hidden="true"><defs><filter id="rough"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="2.2"/></filter></defs></svg>
  <header class="header">
    <a class="brand" href="/" aria-label="Blink home"><span class="shutter" aria-hidden="true"></span>Blink</a>
    <nav aria-label="Main navigation"><a class="nav-link" href="/gallery">Gallery</a><button id="new" type="button" disabled>New</button></nav>
  </header>
  <main>
    <div id="builder">
    <section class="intro" aria-labelledby="headline">
      <h1 id="headline">Think it. <em>Blink it.</em></h1>
      <p class="sub">Describe an app in one sentence. Get four working versions side by side in seconds. Circle the one you like and keep going.</p>
      <form id="prompt-form">
        <label class="sr-only" for="prompt">Describe your app</label>
        <div class="prompt-bar">
          <input id="prompt" name="prompt" type="text" placeholder="What do you want to make?" autocomplete="off" maxlength="500" required>
          <button id="mic" class="mic-button" type="button" aria-label="Speak your prompt" aria-pressed="false" aria-describedby="voice-status" hidden><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg></button>
          <button id="variations" class="variations-control" type="button" aria-pressed="false">×4 variations</button>
          <button id="submit" class="primary-button" type="submit" aria-label="Blink your app" disabled>Blink</button>
        </div>
        <p id="voice-status" class="config-message voice-status" role="status"></p>
      </form>
      <div class="examples" aria-label="Example prompts"></div>
    </section>
    <div id="empty-film" class="empty-film strip">
      <div class="blank-frames" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
      <p>Your four versions will develop here.</p>
    </div>
    <div class="workspace-heading">
      <p>From idea to interaction<span class="workspace-detail"> · live workspace</span></p>
      <label id="race-control" class="race-control" hidden><input id="race" type="checkbox"><span>Race mode</span><span class="toggle" aria-hidden="true"></span></label>
    </div>
    <section id="variations-strip" aria-label="Film strip" hidden>
      <div class="strip-label"><b id="strip-title">Four variations</b><span id="roll-status" role="status">Pick a frame to keep going</span></div>
      <div id="variations-grid" class="variations-grid strip" aria-label="Four variations"></div>
    </section>
    <div id="lanes" class="lanes" aria-label="Workspace"></div>
    <p id="config-message" class="config-message" role="status"></p>
    <div id="load-error" class="load-error" role="alert" hidden><span></span><button type="button" class="quiet-button">Retry</button></div>
    </div>
    <section class="gallery-section" aria-labelledby="gallery-title">
      <div class="gallery-heading"><h2 id="gallery-title">Contact sheet</h2><a id="gallery-link" class="quiet-button" href="/gallery">See all</a></div>
      <div id="gallery-grid" class="gallery-grid"></div>
      <p id="gallery-message" class="config-message" role="status"></p>
      <button id="load-more" class="quiet-button" type="button">Load more</button>
    </section>
  </main>
  <div id="toast" class="toast" role="status" hidden></div>
  <footer>Blink</footer>
`;

function element<T extends HTMLElement>(selector: string, root: ParentNode = document): T {
  return root.querySelector<T>(selector)!;
}

const form = element<HTMLFormElement>('#prompt-form');
const prompt = element<HTMLInputElement>('#prompt');
const mic = element<HTMLButtonElement>('#mic');
const voiceStatus = element<HTMLElement>('#voice-status');
const submit = element<HTMLButtonElement>('#submit');
const newButton = element<HTMLButtonElement>('#new');
const race = element<HTMLInputElement>('#race');
const lanesElement = element<HTMLDivElement>('#lanes');
const variations = element<HTMLButtonElement>('#variations');
const variationsStrip = element<HTMLElement>('#variations-strip');
const variationsGrid = element<HTMLDivElement>('#variations-grid');
const galleryOnly = location.pathname === '/gallery';
element('#builder').hidden = galleryOnly;
element('#new').hidden = galleryOnly;
element('#gallery-link').hidden = galleryOnly;
let choosingVariation = false;
let remixLoading = false;
let lastRun: { idea: string; mode: 'solo' | 'race' | 'variations'; bodies: GenerateBody[] } | null = null;
let toastTimer = 0;
let retryTimer = 0;
let variantsEnabled = true;
let modelLabel = 'Model';
function toast(message: string, error = false) {
  const root = element('#toast');
  root.textContent = message;
  root.classList.toggle('is-error', error);
  root.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { root.hidden = true; }, 4000);
}
let controller: AbortController | null = null;
let frame = 0;
let choiceTimer = 0;

// Speech recognition is still prefixed in some browsers and absent in others.
interface VoiceRecognition {
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
const speechWindow = window as Window & {
  SpeechRecognition?: new () => VoiceRecognition;
  webkitSpeechRecognition?: new () => VoiceRecognition;
};
const SpeechRecognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
let recognition: VoiceRecognition | null = null;
mic.hidden = !SpeechRecognition;

function stopListening(discardResults = true) {
  const current = recognition;
  if (discardResults) recognition = null;
  mic.setAttribute('aria-pressed', 'false');
  mic.setAttribute('aria-label', 'Speak your prompt');
  // Some engines throw if speech has already ended.
  try { current?.stop(); } catch { /* Already stopped. */ }
}

mic.addEventListener('click', () => {
  // A manual stop can still deliver a final transcript before onend.
  if (recognition) { stopListening(false); return; }
  if (!SpeechRecognition || prompt.disabled) return;
  voiceStatus.textContent = '';
  try {
    const current = new SpeechRecognition();
    recognition = current;
    current.interimResults = true;
    current.continuous = false;
    current.onresult = event => {
      if (recognition !== current) return;
      prompt.value = Array.from(event.results, result => result[0].transcript).join('').slice(0, prompt.maxLength);
      updateControls();
    };
    current.onerror = event => {
      if (recognition !== current) return;
      voiceStatus.textContent = event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'Allow microphone access to speak your prompt.' : event.error === 'no-speech'
        ? 'No speech heard. Try again.' : 'Voice input stopped. Please try again.';
      stopListening();
    };
    current.onend = () => { if (recognition === current) stopListening(); };
    mic.setAttribute('aria-pressed', 'true');
    mic.setAttribute('aria-label', 'Stop listening');
    current.start();
  } catch {
    stopListening();
    voiceStatus.textContent = 'Voice input could not start. Please try again.';
  }
});

function variationsOn() { return variations.getAttribute('aria-pressed') === 'true'; }
function setVariations(on: boolean) { variations.setAttribute('aria-pressed', String(on)); }

function createLane(id: string, label: string, host: HTMLElement = lanesElement) {
  const isVariant = id.startsWith('variant-');
  const root = document.createElement('section');
  root.className = `lane lane-${id}${isVariant ? ' mini-lane frame' : ''}`;
  root.setAttribute('aria-label', label);
  const status = '<span class="lane-status" role="status">Ready to Blink</span>';
  root.innerHTML = `
    ${isVariant ? '<svg class="circle" viewBox="0 0 300 240" preserveAspectRatio="none" aria-hidden="true"><path d="M150 8 C 260 4 296 50 292 120 C 288 200 230 232 146 230 C 50 228 8 190 10 116 C 12 46 70 12 166 14"/></svg>' : ''}
    <div class="lane-heading"><h3></h3>${isVariant ? '' : status}</div>
    <div class="panels">
      <section class="panel code-panel" aria-label="Generated code">
        <div class="panel-heading"><span>index.html</span><span class="code-meta">Source</span></div>
        <pre tabindex="0" aria-label="Generated HTML source"><code></code></pre>
      </section>
      <section class="panel preview-panel" aria-label="App preview">
        <div class="panel-heading"><span>Preview · live</span></div>
        <div class="preview-body${isVariant ? ' exposure' : ''}">
          <div class="preview-empty"><span class="shutter" aria-hidden="true"></span><strong>Your next idea lives here.</strong><span>Describe it above. Play it here.</span></div>
          <iframe sandbox="allow-scripts" hidden></iframe>
          ${isVariant ? `${status}<pre class="code-rain" aria-hidden="true"></pre>` : ''}
        </div>
        ${isVariant ? '<div class="frame-edge"><span class="frame-label"></span><span class="frame-metrics"></span></div>' : ''}
        <div class="stats-bar">
          <div class="stat speed"><div><span data-stat="speed">—</span></div><span class="stat-label">tok/s</span></div>
          <div class="stat"><div><span data-stat="tokens">—</span></div><span class="stat-label token-label">Output tokens</span></div>
          <div class="stat"><div><span data-stat="total">—</span><span class="stat-unit">s</span></div><span class="stat-label">Total</span></div>
          <div class="stat"><div><span data-stat="ttft">—</span><span class="stat-unit">ms</span></div><span class="stat-label">First token</span></div>
          <p class="measurement">Measured by Blink<span class="estimate">Waiting for your idea</span></p>
        </div>
        ${id === 'cerebras' ? '<p class="powered-by"></p>' : ''}
        <div class="lane-actions">
          <form class="remix-form"><input class="remix-prompt" aria-label="Describe your remix" placeholder="Change it: add a streak counter…" maxlength="500" required disabled><button class="remix primary-button" type="submit" disabled>Remix</button></form>
          <button class="share quiet-button" type="button" disabled>Share</button>
          <button class="download quiet-button" type="button" disabled>Download <span class="sr-only">.html</span></button>
          <button class="use-variant pick" type="button" hidden>Use this one</button>
          <div class="share-links" hidden><a class="post-x" target="_blank" rel="noopener noreferrer">Post on X ↗</a><a class="open-share" target="_blank" rel="noopener noreferrer">Open ↗</a><input class="share-url" readonly aria-label="Share URL"></div>
        </div>
      </section>
    </div>
    <div class="lane-error" role="alert" hidden><span></span><button class="retry quiet-button" type="button">Retry</button></div>
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
  element('.remix-form', root).addEventListener('submit', event => {
    event.preventDefault();
    if (controller || remixLoading || !lane.appId) return;
    const input = element<HTMLInputElement>('.remix-prompt', root);
    prompt.value = input.value;
    updateControls();
    form.requestSubmit();
  });
  host.append(root);
  return lane;
}

const cerebras = createLane('cerebras', 'Workspace');
const compare = createLane('compare', 'Comparison');
compare.root.hidden = true;
const variantLanes = ['Classic', 'Bold', 'Minimal', 'Retro'].map((label, index) => {
  const lane = createLane(`variant-${index}`, label, variationsGrid);
  element('.frame-label', lane.root).textContent = `${index + 1}A ▸ ${label}`;
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
  const busy = controller !== null || remixLoading || choiceTimer !== 0;
  const remix = !choosingVariation && activeLanes().some(lane => lane.appId);
  prompt.disabled = busy;
  mic.disabled = busy;
  prompt.placeholder = remix ? 'What would you like to change?' : 'What do you want to make?';
  prompt.setAttribute('aria-label', remix ? 'Describe your remix' : 'Describe your app');
  submit.disabled = busy || !prompt.value.trim();
  submit.textContent = busy ? 'Blinking…' : remix ? 'Remix' : 'Blink';
  submit.setAttribute('aria-label', remix ? 'Remix your app' : 'Blink your app');
  const label = race.checked ? modelLabel : 'Workspace';
  element('h3', cerebras.root).textContent = label;
  cerebras.root.setAttribute('aria-label', label);
  cerebras.iframe.title = `${label} app preview`;
  race.disabled = busy;
  variations.disabled = busy || !variantsEnabled;
  newButton.disabled = !busy && !generationLanes.some(lane => lane.text || lane.html || lane.error);
  document.querySelectorAll<HTMLButtonElement>('.example').forEach(button => { button.disabled = busy; });
  for (const lane of generationLanes) {
    element<HTMLInputElement>('.remix-prompt', lane.root).disabled = busy || choosingVariation || !lane.appId || lane.phase !== 'done';
    element<HTMLButtonElement>('.remix', lane.root).disabled = busy || choosingVariation || !lane.appId || lane.phase !== 'done';
    lane.download.disabled = busy || !lane.html || lane.phase !== 'done';
    element<HTMLButtonElement>('.share', lane.root).disabled = busy || !lane.appId || lane.phase !== 'done' || lane.sharing;
    element<HTMLButtonElement>('.use-variant', lane.root).disabled = choiceTimer !== 0 || !choosingVariation || !lane.html || lane.phase !== 'done';
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
  if (lane.root.classList.contains('frame')) {
    const totalMs = lane.stats?.totalMs ?? (lane.started ? elapsed : null);
    const seconds = totalMs === null ? '—' : (totalMs / 1000).toFixed(1);
    element('.frame-metrics', lane.root).textContent = lane.error ? 'Needs attention' : lane.text
      ? `${values.speed} tok/s · ${seconds} s` : lane.position > 0 ? `Queue #${lane.position}` : 'Waiting';
  }
}

function renderLane(lane: LaneState) {
  lane.code.textContent = lane.text || '// Your idea becomes a complete HTML app.\n// The code will stream here as it is written.';
  lane.pre.scrollTop = lane.pre.scrollHeight;
  lane.root.classList.toggle('is-streaming', lane.streaming);
  lane.root.setAttribute('aria-busy', String(lane.streaming));
  lane.status.textContent = lane.phase === 'stopped' ? 'Stopped' : lane.error ? 'Needs attention' : lane.streaming
    ? generationStatus(lane, lane.position, performance.now()) : lane.html ? 'Ready to play' : 'Ready to Blink';
  if (lane.root.classList.contains('frame')) {
    const hasCompletedHtml = lane.phase === 'done' && !!lane.html;
    const state = lane.phase === 'stopped' ? 'stopped' : hasCompletedHtml ? (lane.error ? 'preview-error' : 'done') : lane.error || lane.phase === 'done' ? 'error' : lane.phase === 'streaming' ? 'developing' : 'queued';
    lane.root.setAttribute('data-state', state);
    element('.use-variant', lane.root).hidden = !hasCompletedHtml;
    element('.code-rain', lane.root).textContent = lane.text;
    if (state === 'queued' && lane.position === 0) {
      const seconds = Math.max(0, Math.floor((performance.now() - (lane.waitingAt ?? lane.started)) / 1000));
      lane.status.textContent = `Waiting for the model · ${seconds}\u00a0s`;
    }
    const completed = variantLanes.filter(variant => variant.phase === 'done').length;
    const tokens = variantLanes.reduce((sum, variant) => sum + (variant.stats?.outputTokens ?? 0), 0);
    element('#roll-status').textContent = completed === 4 ? `4 frames · ${tokens.toLocaleString()} tokens` : `${completed}/4 frames developed`;
  }
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
  if (choiceTimer || !choosingVariation || !lane.html || lane.phase !== 'done') return;
  stopListening();
  const run = controller;
  controller = null;
  run?.abort();
  for (const variant of variantLanes) {
    if (variant.phase === 'done' || variant.phase === 'error') continue;
    variant.streaming = false;
    variant.phase = 'stopped';
    clearLanePreview(variant);
    renderLane(variant);
  }
  for (const variant of variantLanes) variant.root.classList.toggle('chosen', variant === lane);
  const expand = () => {
    choiceTimer = 0;
    if (controller || !choosingVariation) return;
    choosingVariation = false;
    variationsStrip.hidden = true;
    lanesElement.hidden = false;
    setVariations(false);
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
    // Stop unused apps; the selected workspace gets its own fresh sandbox.
    for (const variant of variantLanes) clearLanePreview(variant);
    renderLane(cerebras);
    prompt.value = '';
    updateControls();
    scrollIntoView(lanesElement);
    element<HTMLInputElement>('.remix-prompt', cerebras.root).focus({ preventScroll: true });
  };
  // Keep the circle visible before expanding into the existing workspace.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) expand();
  else {
    choiceTimer = window.setTimeout(expand, 700);
    updateControls();
  }
}

function scrollIntoView(target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  if (rect.top >= 0 && rect.bottom <= window.innerHeight) return;
  target.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}

async function shareLane(lane: LaneState) {
  if (!lane.appId || lane.sharing) return;
  const id = lane.appId;
  lane.sharing = true;
  updateControls();
  try {
    const links = buildShareLinks(location.origin, await shareApp(id));
    void loadGalleryPage(true);
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
    toast(error instanceof Error ? error.message : 'Sharing failed. Please try again.', true);
  } finally {
    lane.sharing = false;
    updateControls();
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  const idea = prompt.value.trim();
  if (!idea || idea.length > prompt.maxLength || controller || remixLoading || choiceTimer) return;
  if (race.checked) syncRaceContexts();
  const mode = race.checked ? 'race' : variationsOn() ? 'variations' : 'solo';
  const sources = mode === 'race' ? [cerebras, compare] : [cerebras];
  const bodies: GenerateBody[] = sources.map(lane => ({
    prompt: idea, lane: lane.id as Lane, conversationId: lane.conversationId,
    variants: mode === 'variations' ? 4 : 1,
    ...(lane.appId && !choosingVariation ? { remixOf: lane.appId } : {}),
  }));
  return runGeneration({ idea, mode, bodies });
});

async function runGeneration(request: NonNullable<typeof lastRun>) {
  if (controller || remixLoading || choiceTimer) return;
  stopListening();
  window.clearTimeout(choiceTimer);
  choiceTimer = 0;
  lastRun = request;
  const run = new AbortController();
  controller = run;
  choosingVariation = request.mode === 'variations';
  race.checked = request.mode === 'race';
  setVariations(choosingVariation);
  variationsStrip.hidden = !choosingVariation;
  element('#strip-title').textContent = choosingVariation && request.bodies[0].remixOf
    ? `Remix ×4 · ${request.idea}` : 'Four variations';
  lanesElement.hidden = choosingVariation;
  element('#empty-film').hidden = true;
  for (const lane of variantLanes) lane.root.classList.toggle('chosen', false);
  compare.root.hidden = !race.checked;
  lanesElement.classList.toggle('is-racing', race.checked);
  const started = performance.now();
  const selected = activeLanes();
  const previous = new Map(selected.filter(lane => !choosingVariation && lane.html).map(lane => [lane, {
    text: lane.text, stats: lane.stats, started: lane.started, firstDelta: lane.firstDelta,
    phase: lane.phase,
  }]));
  const runId = request.mode === 'race' ? crypto.randomUUID().replace(/-/g, '') : undefined;
  for (const lane of selected) {
    if (choosingVariation) { lane.html = ''; lane.appId = null; }
    if (!previous.has(lane)) clearLanePreview(lane);
    lane.text = lane.error = '';
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
    renderLane(lane);
  }
  updateControls();
  scrollIntoView(choosingVariation ? variationsStrip : lanesElement);
  const timer = window.setInterval(() => {
    if (controller !== run) { window.clearInterval(timer); return; }
    for (const lane of selected) if (lane.streaming) renderLane(lane);
    updateControls();
  }, 250);
  let succeeded = false;
  await Promise.all(request.bodies.map(async (body, index) => {
    const targets = request.mode === 'variations' ? variantLanes : [selected[index]];
    let state = createGeneration(targets.length);
    try {
      await generate(runId ? { ...body, runId } : body, event => {
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
            if (!previous.has(lane) && !lane.previewSet) {
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
              const html = extractHtml(lane.text);
              if (html === null) {
                lane.error = 'No complete HTML app was returned. Please try again.';
                lane.errorKind = 'generation';
                lane.retryable = true;
                lane.phase = 'error';
              } else {
                lane.stats = next.stats;
                lane.appId = next.appId;
                element('.share-links', lane.root).hidden = true;
                if (html !== lane.html) setPreview(lane, html);
                succeeded = true;
              }
            }
            renderLane(lane);
            updateControls();
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
        const saved = previous.get(lane);
        if (saved && lane.phase !== 'done') Object.assign(lane, saved);
        renderLane(lane);
      }
    }
  }));
  clearInterval(timer);
  if (controller !== run) return;
  controller = null;
  if (choosingVariation && !succeeded && request.bodies[0].remixOf && cerebras.appId && cerebras.html) {
    choosingVariation = false;
    lanesElement.hidden = false;
    setVariations(false);
  }
  if (succeeded) {
    prompt.value = '';
    for (const lane of selected) element<HTMLInputElement>('.remix-prompt', lane.root).value = '';
  }
  window.clearInterval(retryTimer);
  if (selected.some(lane => lane.retryAt > Date.now())) retryTimer = window.setInterval(() => {
    updateControls();
    if (selected.every(lane => lane.retryAt <= Date.now())) window.clearInterval(retryTimer);
  }, 1000);
  updateControls();
  prompt.focus({ preventScroll: true });
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
  stopListening();
  voiceStatus.textContent = '';
  controller?.abort();
  controller = null;
  remixLoading = false;
  window.clearInterval(retryTimer);
  window.clearTimeout(choiceTimer);
  choiceTimer = 0;
  lastRun = null;
  choosingVariation = false;
  variationsStrip.hidden = true;
  lanesElement.hidden = true;
  element('#empty-film').hidden = false;
  element('#load-error').hidden = true;
  history.replaceState(null, '', location.pathname);
  for (const lane of generationLanes) {
    clearLanePreview(lane);
    lane.appId = null;
    lane.phase = 'idle';
    lane.retryable = false;
    lane.conversationId = crypto.randomUUID();
    lane.root.classList.toggle('chosen', false);
    element<HTMLInputElement>('.remix-prompt', lane.root).value = '';
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
    setVariations(false);
    choosingVariation = false;
    variationsStrip.hidden = true;
    lanesElement.hidden = !generationLanes.some(lane => lane.text || lane.html || lane.error);
    syncRaceContexts();
  }
  compare.root.hidden = !race.checked;
  lanesElement.classList.toggle('is-racing', race.checked);
  updateControls();
});

variations.addEventListener('click', () => {
  setVariations(!variationsOn());
  if (variationsOn()) {
    race.checked = false;
    compare.root.hidden = true;
    lanesElement.classList.toggle('is-racing', false);
  }
  updateControls();
});

for (const lane of generationLanes) renderLane(lane);
lanesElement.hidden = true;
element('#empty-film').hidden = false;
updateControls();
getConfig().then(config => {
  modelLabel = config.modelLabel;
  element('.powered-by', cerebras.root).textContent = `Powered by ${modelLabel}`;
  element('footer').textContent = `Blink · Powered by ${modelLabel}`;
  variantsEnabled = config.variantsEnabled;
  updateControls();
  element('.variations-control').hidden = !config.variantsEnabled;
  prompt.maxLength = Math.min(500, config.maxPromptChars);
  for (const lane of generationLanes) element<HTMLInputElement>('.remix-prompt', lane.root).maxLength = prompt.maxLength;
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
  stopListening();
  const run = new AbortController();
  controller?.abort();
  controller = run;
  remixLoading = true;
  lanesElement.hidden = false;
  element('#empty-film').hidden = true;
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
  card.innerHTML = `<div class="gallery-preview"><button class="preview-trigger" type="button"><span class="shutter" aria-hidden="true"></span><span>Try live preview</span></button></div><div class="gallery-copy"><a target="_blank" rel="noopener noreferrer"><h3></h3></a><time></time></div>`;
  element('h3', card).textContent = app.title || 'Untitled app';
  element<HTMLAnchorElement>('a', card).title = app.prompt;
  const age = Math.max(0, Math.floor((Date.now() - app.createdAt) / 1000));
  const time = element<HTMLTimeElement>('time', card);
  time.dateTime = new Date(app.createdAt).toISOString();
  time.textContent = age < 60 ? 'now' : age < 3600 ? `${Math.floor(age / 60)}m` : age < 86400 ? `${Math.floor(age / 3600)}h` : `${Math.floor(age / 86400)}d`;
  time.title = new Date(app.createdAt).toLocaleString();
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
  element('#gallery-message').classList.toggle('is-error', Boolean(gallery.error));
  element('#gallery-message').textContent = gallery.error || (gallery.loading ? 'Loading community apps…' :
    gallery.loaded && !gallery.items.length ? 'The gallery is waiting for its first app. Make something and share it.' : '');
}

async function loadGalleryPage(refresh = false) {
  if (refresh) {
    gallery = createGallery();
    galleryGrid.replaceChildren();
    for (let index = lanes.length - 1; index >= generationLanes.length; index--) {
      resetPreviewWatch(lanes[index]);
      lanes.splice(index, 1);
    }
  }
  const next = beginGalleryPage(gallery);
  if (next === gallery) return;
  gallery = next;
  const loading = gallery;
  renderGalleryState();
  try {
    const page = await getGallery(gallery.nextCursor);
    if (gallery !== loading) return;
    const count = gallery.items.length;
    gallery = finishGalleryPage(gallery, page);
    for (const app of gallery.items.slice(count)) galleryGrid.append(galleryCard(app));
  } catch (error) {
    if (gallery !== loading) return;
    gallery = failGalleryPage(gallery, error instanceof Error ? error.message : 'The gallery couldn’t be loaded. Please try again.');
  }
  renderGalleryState();
}
loadMore.addEventListener('click', () => { void loadGalleryPage(); });
void loadGalleryPage();
