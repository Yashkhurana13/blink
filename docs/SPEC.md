# Blink: spec

Status: approved by delegation on 2026-11-22. The user asked Claude to finish the project overnight, so Claude made the design calls below; the user reviews them in the morning.

## What it is

Blink turns one sentence into a working mini web app or game, in about the time it takes to blink. You type "a neon snake game where the snake leaves a rainbow trail", and a playable app appears in a live preview while its code streams in beside it. A stats bar shows the time to the first token, the total time and the tokens per second.

The model is Kimi K3.1 Pro on Cerebras, reached through an OpenClaw agent (`blink`) on the standard OpenClaw gateway.

## Why this project

- The prizes are X impressions and Reddit upvotes. A one-sentence prompt that turns into a playable game in seconds is easy to understand and share in a 60-second video.
- Cerebras speed is the point of the demo: at ~1,000 tok/s a 3,000-token app arrives in about 3 seconds, where a GPU provider takes 30 seconds or more.
- It meets the hard rules: Kimi on Cerebras is the only model, and every request runs as an OpenClaw agent run.

## Users and flow

1. Open Blink at `http://127.0.0.1:5173`.
2. Type an idea, or click one of 6 example chips (a game, a tool, a toy, an animation).
3. Press Blink. The code streams into the code panel. As soon as the closing `</html>` arrives, the preview runs the app.
4. Remix: type a change ("make it night mode", "add a high score") and Blink sends the change plus the current app, in the same conversation, and the preview updates.
5. Download the app as a single `.html` file.

## Speed display

- Time to the first token, total generation time, output tokens, and tok/s, all measured by the Blink server (tokens are estimated as characters ÷ 4 when the gateway doesn't report usage). The label says "measured by Blink" so it isn't confused with the speed patch.
- The stats bar is large and readable in a screen recording.

## Optional side-by-side race

If `COMPARE_BASE_URL`, `COMPARE_API_KEY`, `COMPARE_MODEL` and `COMPARE_LABEL` are set, a Race toggle shows a second lane that sends the same prompt directly to that OpenAI-compatible provider (for example, a GPU host). The two lanes stream side by side with their own stats. Without those variables the toggle is hidden. Nothing is simulated; the comparison only appears with a real second provider.

## Architecture

- `server/`: a Node 24 HTTP server with no framework (`node:http`). It serves the built frontend and two endpoints:
  - `POST /api/generate` `{prompt, conversationId?, currentHtml?, lane: "cerebras" | "compare"}` streams Server-Sent Events: `{type: "delta", text}`, `{type: "done", stats}`, `{type: "error", message}`.
  - `GET /api/config` returns `{compareEnabled, compareLabel}`.
- The cerebras lane calls the OpenClaw gateway at `OPENCLAW_BASE_URL` (default `http://127.0.0.1:18789`) `POST /v1/chat/completions` with `model: "openclaw/blink"`, `stream: true`, `user: <conversationId>` and `Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN`. The token stays on the server.
- `web/`: Vite + vanilla TypeScript. A prompt bar, example chips, a code panel (streamed text, auto-scrolled), a sandboxed preview (`<iframe sandbox="allow-scripts" srcdoc=...>`), and the stats bar.
- HTML extraction: take the text from the first `<!doctype html>` or `<html` to the last `</html>`, removing Markdown fences. If there's no closing tag yet, the preview waits.

## OpenClaw setup (done by Claude, not part of the app code)

- Standard OpenClaw (`~/.openclaw`), gateway on port 18789.
- `gateway.http.endpoints.chatCompletions.enabled: true`.
- An agent `blink` whose workspace `AGENTS.md` tells it to return one complete self-contained HTML file (inline CSS and JS, no external requests, no Markdown commentary), with no tools.
- Thinking `low`, temperature 1.0.

## Out of scope

Accounts, hosting, saving to a gallery, multi-file apps, and image generation.

## Done when

- `npm test` passes (unit tests for the SSE parser, HTML extraction, stats, and the server against a fake gateway).
- `npm run build` succeeds, and `npm start` serves the app.
- A live prompt through the real OpenClaw gateway produces a working preview.
