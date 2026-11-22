import { generate, getConfig, type Lane, type Stats } from './api.ts';
import { extractHtml } from './extract.ts';
import { syncRaceLanes } from './lanes.ts';
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
    <button id="new" class="quiet-button" type="button" disabled>New <span aria-hidden="true">↗</span></button>
  </header>
  <main>
    <section class="intro" aria-labelledby="headline">
      <p class="eyebrow"><span class="signal" aria-hidden="true"></span> One sentence. A working app.</p>
      <h2 id="headline">Think it.<br class="mobile-break"> <span>Blink it.</span></h2>
      <form id="prompt-form">
        <label class="sr-only" for="prompt">Describe your app</label>
        <div class="prompt-bar">
          <span class="prompt-symbol" aria-hidden="true">↳</span>
          <input id="prompt" name="prompt" type="text" placeholder="What do you want to make?" autocomplete="off" required>
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
    <p id="config-message" class="config-message" role="status"></p>
  </main>
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
let controller: AbortController | null = null;
let frame = 0;

function createLane(id: Lane, label: string) {
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
    <p class="lane-error" role="alert" hidden></p>
    <div class="stats-bar">
      <div class="stat speed"><div><span data-stat="speed">—</span><span class="stat-unit">tok/s</span></div><span class="stat-label">Generation speed</span></div>
      <div class="stat"><div><span data-stat="total">—</span><span class="stat-unit">s</span></div><span class="stat-label">Total time</span></div>
      <div class="stat"><div><span data-stat="ttft">—</span><span class="stat-unit">ms</span></div><span class="stat-label">First token</span></div>
      <div class="stat"><div><span data-stat="tokens">—</span></div><span class="stat-label token-label">Output tokens</span></div>
      <p class="measurement">measured by Blink<span class="estimate">Waiting for your idea</span></p>
    </div>
  `;
  element('h3', root).textContent = label;
  element<HTMLIFrameElement>('iframe', root).title = `${label} app preview`;
  const conversationId: string = crypto.randomUUID();
  const lane = {
    id, root, conversationId, html: '', text: '', error: '',
    streaming: false, previewSet: false, started: 0, firstDelta: null as number | null,
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
  lanesElement.append(root);
  return lane;
}

const cerebras = createLane('cerebras', 'Cerebras · Kimi K3.1 Pro');
const compare = createLane('compare', 'Comparison');
compare.root.hidden = true;
const lanes = [cerebras, compare];
type LaneState = typeof cerebras;

function activeLanes() {
  return race.checked ? lanes : [cerebras];
}

function updateControls() {
  const busy = controller !== null;
  const remix = activeLanes().some(lane => lane.html);
  prompt.disabled = busy;
  prompt.placeholder = remix ? 'What would you like to change?' : 'What do you want to make?';
  prompt.setAttribute('aria-label', remix ? 'Describe your remix' : 'Describe your app');
  submit.disabled = busy || !prompt.value.trim();
  submit.innerHTML = busy ? 'Blinking<span class="button-pulse" aria-hidden="true">…</span>' : `${remix ? 'Remix' : 'Blink'} <span aria-hidden="true">↗</span>`;
  race.disabled = busy;
  newButton.disabled = !busy && !lanes.some(lane => lane.text || lane.html || lane.error);
  document.querySelectorAll<HTMLButtonElement>('.example').forEach(button => { button.disabled = busy; });
  for (const lane of lanes) lane.download.disabled = busy || !lane.html;
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
  lane.status.textContent = lane.error ? 'Needs attention' : lane.streaming ? 'Streaming' : lane.html ? 'Ready to play' : 'Ready to Blink';
  const error = element<HTMLElement>('.lane-error', lane.root);
  error.textContent = lane.error;
  error.hidden = !lane.error;
  renderStats(lane);
}

function setPreview(lane: LaneState, html: string) {
  lane.html = html;
  lane.previewSet = true;
  lane.iframe.srcdoc = html;
  lane.iframe.hidden = false;
  element<HTMLElement>('.preview-empty', lane.root).hidden = true;
}

function syncRaceContexts(refreshCompare = false) {
  const contexts = syncRaceLanes(cerebras, compare, crypto.randomUUID(), refreshCompare);
  lanes.forEach((lane, index) => {
    const context = contexts[index];
    if (context === lane) return;
    lane.conversationId = context.conversationId;
    lane.text = context.html;
    lane.error = '';
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

form.addEventListener('submit', async event => {
  event.preventDefault();
  const idea = prompt.value.trim();
  if (!idea || controller) return;
  if (race.checked) syncRaceContexts();
  const run = new AbortController();
  controller = run;
  const started = performance.now();
  const selected = activeLanes();
  for (const lane of selected) {
    lane.text = '';
    lane.error = '';
    lane.stats = null;
    lane.firstDelta = null;
    lane.started = started;
    lane.streaming = true;
    lane.previewSet = false;
    renderLane(lane);
  }
  updateControls();
  const timer = window.setInterval(() => {
    for (const lane of selected) if (lane.streaming) renderStats(lane);
  }, 100);
  let succeeded = false;
  await Promise.all(selected.map(async lane => {
    try {
      await generate({
        prompt: idea, lane: lane.id, conversationId: lane.conversationId,
        ...(lane.html ? { currentHtml: lane.html } : {}),
      }, event => {
        if (controller !== run) return;
        if (event.type === 'delta') {
          if (event.text && lane.firstDelta === null) lane.firstDelta = performance.now();
          lane.text += event.text;
          if (!lane.previewSet) {
            const html = extractHtml(lane.text);
            if (html !== null) setPreview(lane, html);
          }
          scheduleRender();
        } else {
          lane.streaming = false;
          if (event.type === 'error') lane.error = event.message;
          else {
            lane.stats = event.stats;
            const html = extractHtml(lane.text);
            if (html === null) lane.error = 'No complete HTML app was returned. Please try again.';
            else { setPreview(lane, html); succeeded = true; }
          }
          renderLane(lane);
        }
      }, run.signal);
    } catch (error) {
      if (controller !== run) return;
      lane.error = error instanceof Error ? error.message : 'Generation failed. Please try again.';
    } finally {
      if (controller === run) {
        lane.streaming = false;
        renderLane(lane);
      }
    }
  }));
  clearInterval(timer);
  if (controller !== run) return;
  controller = null;
  if (succeeded) prompt.value = '';
  updateControls();
  prompt.focus();
});

newButton.addEventListener('click', () => {
  controller?.abort();
  controller = null;
  for (const lane of lanes) {
    lane.conversationId = crypto.randomUUID();
    lane.html = lane.text = lane.error = '';
    lane.streaming = lane.previewSet = false;
    lane.stats = lane.firstDelta = null;
    lane.started = 0;
    lane.iframe.removeAttribute('srcdoc');
    lane.iframe.hidden = true;
    element<HTMLElement>('.preview-empty', lane.root).hidden = false;
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
  if (race.checked) syncRaceContexts(true);
  compare.root.hidden = !race.checked;
  lanesElement.classList.toggle('is-racing', race.checked);
  updateControls();
});

for (const lane of lanes) renderLane(lane);
getConfig().then(config => {
  if (!config.compareEnabled) return;
  element('#race-control').hidden = false;
  const label = config.compareLabel || 'Comparison';
  element('h3', compare.root).textContent = label;
  compare.root.setAttribute('aria-label', label);
  compare.iframe.title = `${label} app preview`;
}).catch(() => {
  element('#config-message').textContent = 'Race availability could not be loaded. You can still Blink an app.';
});
