# Blink: implementation plan

Read `docs/SPEC.md` first. Codex writes all code. Task 1 runs first; Tasks 2 and 3 are independent and run in parallel after Task 1 is merged.

## Shared contracts

- SSE events from `POST /api/generate`, one JSON object per `data:` line:
  - `{"type":"delta","text":string}`
  - `{"type":"done","stats":{"ttftMs":number,"totalMs":number,"outputTokens":number,"tokensPerSecond":number,"tokensEstimated":boolean}}`
  - `{"type":"error","message":string}`
- Request body: `{"prompt":string,"conversationId"?:string,"currentHtml"?:string,"lane":"cerebras"|"compare"}`.
- `GET /api/config` returns `{"compareEnabled":boolean,"compareLabel":string|null}`.
- `tokensPerSecond = (outputTokens - 1) / ((lastTokenTime - firstTokenTime) / 1000)`, or 0 when there are fewer than 2 tokens.

## Task 1: scaffold (independent, first)

Files: `package.json`, `tsconfig.json`, `vite.config.ts`, `web/index.html`, `web/src/main.ts` (placeholder), `server/index.ts` (placeholder that serves `dist/web`), `.gitignore`, `README.md`.

- Node 24, TypeScript run with `tsx` for the server, Vite for `web/`, tests with `node --test` through `tsx`.
- Scripts: `dev` (Vite dev server on 5173 proxying `/api` to the Node server on 5174, plus the server), `build` (Vite build to `dist/web`), `start` (server on 5173 serving `dist/web` and `/api`), `test`.
- Acceptance: `npm install && npm test && npm run build` succeed; `npm start` serves the placeholder page.

## Task 2: server (after Task 1; parallel with Task 3)

Files: `server/**`, `server/**/*.test.ts`. Don't touch `web/`.

- `server/sse.ts`: parse an OpenAI-style chat-completions SSE stream (`data: {...}` lines, `data: [DONE]`) into text deltas and an optional final `usage.completion_tokens`. Handle chunks split mid-line.
- `server/stats.ts`: a tracker that records the request start, first and last delta times, and output tokens (usage when present, else characters ÷ 4 with `tokensEstimated: true`), and produces the `done` stats from the contract.
- `server/prompt.ts`: build the messages. A new app sends the prompt. A remix sends "Here is the current app:\n<currentHtml>\n\nChange it: <prompt>. Return the complete updated HTML file."
- `server/lanes.ts`:
  - cerebras lane: `POST ${OPENCLAW_BASE_URL}/v1/chat/completions` with `model: "openclaw/blink"`, `stream: true`, `user: conversationId`, and the bearer token from `OPENCLAW_GATEWAY_TOKEN`.
  - compare lane: `POST ${COMPARE_BASE_URL}/chat/completions` with `COMPARE_MODEL`, `stream: true`, the bearer `COMPARE_API_KEY`, and a system message equal to the contents of `agent/AGENTS.md` (so both lanes get the same instructions).
- `server/index.ts`: the endpoints from the contract, static files from `dist/web`, a 3-minute upstream timeout, a client disconnect that aborts the upstream request, and upstream errors turned into an `error` event (never leak the token).
- Tests: the SSE parser (split chunks, `[DONE]`, usage), stats, prompt building, and `/api/generate` end to end against a fake upstream `node:http` server for both lanes; `/api/config` with and without the compare variables.

## Task 3: frontend (after Task 1; parallel with Task 2)

Files: `web/**`. Don't touch `server/`.

- `web/src/extract.ts`: `extractHtml(text): string | null` per the spec, with unit tests (`web/src/extract.test.ts`).
- `web/src/api.ts`: `generate(body, onEvent, signal)` that reads the SSE stream from `/api/generate`.
- UI (`web/src/main.ts`, `web/src/style.css`): a dark, bold look that reads well in a screen recording.
  - Header: "Blink", with the tagline "Apps at the speed of thought. Kimi K3.1 Pro on Cerebras, via OpenClaw."
  - A prompt bar and a Blink button (Enter submits). 6 example chips.
  - A main area split into the code panel (monospace, auto-scroll, a typing cursor while streaming) and the preview (`<iframe sandbox="allow-scripts">` with `srcdoc`, updated when `extractHtml` first returns a value and again on `done`).
  - The stats bar: big numbers for tok/s, total time, time to first token, tokens; the label "measured by Blink". While streaming, show a live tok/s estimate from the received characters.
  - After the first app: the prompt bar becomes "Remix", and it sends `conversationId` and `currentHtml`. A "New" button starts over. A "Download .html" button.
  - Race toggle, shown only when `/api/config` says `compareEnabled`: two lanes side by side (each with code, preview and stats), labelled "Cerebras · Kimi K3.1 Pro" and the compare label, started at the same moment.
- Acceptance: `npm test` and `npm run build` pass; the UI works against Task 2's contract (with the server or a stub).

## After the build (Claude)

Merge 2 then 3, run the full suite after each merge, configure the OpenClaw `blink` agent, run a live end-to-end check in the browser, then run the Codex review.
