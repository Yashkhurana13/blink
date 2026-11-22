# Blink v2: implementation plan

Read [SPEC-v2.md](SPEC-v2.md) first. Task A (server) and Task B (web) run in parallel; they share only the contracts below. Claude handles the tunnel and operations.

## Contracts

### `POST /api/generate` (JSON)

Request: `{"prompt": string (≤500), "variants"?: 1 | 4, "remixOf"?: string /* appId */, "conversationId"?: string, "lane"?: "cerebras" | "compare"}`. `variants` defaults to 1, and race (`lane: "compare"`) only allows 1. With `remixOf`, the server loads that app's HTML and builds the remix prompt itself.

The response is SSE, one JSON object per `data:` line. Every event has `"variant": number` (0-based; always 0 when `variants` is 1) except `queue`:
- `{"type":"queue","position":number}`: sent while waiting in Blink's own queue (position 1 = next), then once more with `position: 0` when it starts.
- `{"type":"status","variant":n,"phase":"waiting_model"}`: the upstream request has been sent but no token has arrived yet.
- `{"type":"delta","variant":n,"text":string}`
- `{"type":"done","variant":n,"stats":{...as v1},"appId":string|null}`: `appId` is set when a complete HTML document was extracted and saved.
- `{"type":"error","variant":n,"message":string,"retryable":boolean}`
- `{"type":"end"}`: the last event, after every variant has finished.

Status codes before the stream starts: 400 (validation), 403/415 (origin/content type), 429 `{"error":"rate_limited","retryAfterSec":n}` (a per-user cap or an active run already in progress), 503 `{"error":"busy","retryAfterSec":n}` (queue full).

### Apps and sharing

- `GET /api/apps/:id` → `{"id","title","prompt","createdAt","shared":boolean,"parentId":string|null}` (never includes the IP hash).
- `POST /api/apps/:id/share` → `{"url":"/a/:id"}`. Allowed only for the client (IP hash) that created the app.
- `GET /a/:id`: the server-rendered share page (an inline-styled HTML page with OG/Twitter tags, a header with the Blink logo and "Make your own" → `/`, the app iframe → `/raw/:id`, a "Remix this" link → `/?remix=:id`, and a Report button). 404 page for unknown or hidden apps, and for apps that aren't shared.
- `GET /raw/:id`: the app HTML with the CSP sandbox headers from the spec. Works only for shared apps, or for the creator's own unshared app.
- `POST /api/apps/:id/report` → `{"ok":true}`. One report per IP hash per app; 3 reports hide the app from the gallery.
- `POST /api/admin/apps/:id/hide` with `Authorization: Bearer $ADMIN_TOKEN` → `{"ok":true}`.
- `GET /api/gallery?cursor=<createdAt>&limit=24` → `{"items":[{"id","title","prompt","createdAt"}],"nextCursor":string|null}`: shared, not hidden, newest first.
- `GET /api/config` → v1 fields plus `{"variantsEnabled":true,"maxPromptChars":500,"publicOrigin":string|null}`.

## Task A: server (`server/**` only)

- `server/db.ts`: `node:sqlite` (no new dependencies) at `$BLINK_DATA_DIR/blink.db` (default `./data`). Table `apps(id TEXT PRIMARY KEY, title, prompt, html, created_at INTEGER, ip_hash, shared INTEGER, hidden INTEGER, parent_id)` and `reports(app_id, ip_hash, PRIMARY KEY(app_id, ip_hash))`. IDs are 10-character random URL-safe strings.
- `server/client.ts`: client identity (the spec's IP rule) and an `ip_hash` built from SHA-256 of `BLINK_SALT` (generated and saved to `data/salt` on first run if unset) plus the IP.
- `server/queue.ts`: a fair scheduler with configurable `MAX_CONCURRENT` (default 8 upstream calls), `MAX_QUEUE` (default 40 jobs), and per-client limits (1 active job, `HOURLY_LIMIT` default 30 generations, where a ×4 counts as 4). A job with N variants takes N slots. It emits position updates to waiting jobs. Unit-test it with fake timers.
- Generation: fan out the variants. Each variant's prompt adds a direction (variant 0: "classic, polished"; 1: "bold, playful, surprising"; 2: "minimal and elegant"; 3: "retro / arcade"). Allow a 6-minute upstream timeout. Retry once automatically when the upstream returns 429/5xx or a network error before the first token. On done, extract the HTML (port of the web `extractHtml` logic), save the app, and include `appId`.
- Share page and raw routes as specified. Escape all text inserted into the share page (title and prompt are untrusted). OG image: `/og.png` served from `server/assets/og.png` if present.
- Keep all existing behaviour and tests passing; update tests whose contract changed (`done.appId`, the `end` event). New tests: queue fairness and limits; 429/503 responses; ×4 fan-out against the fake upstream (4 requests, variant tags); sharing permissions; `/raw` headers; share-page escaping; gallery pagination and the hidden filter; reports and the threshold; admin hide; remix loading the HTML on the server.

## Task B: web (`web/**` only)

- `api.ts`: the new events and `appId`; 429/503 shown as friendly messages using `retryAfterSec`.
- Home layout: hero and prompt bar, a "×4 variations" toggle next to the Blink button (on by default? no: off by default, with a highlighted chip), example chips, the workspace, then a "Fresh from the community" gallery grid at the bottom (infinite "Load more").
- Variations: a 2×2 grid of mini lanes (code hidden, preview shown, each with its own small stats and status), with a "Use this one" button on each. Choosing one expands it into the main workspace (code, preview, stats), sets it as the current app, and enables Remix, Share and Download.
- Status: queue position, "Waiting for Cerebras · 23 s", then streaming. A clear, friendly error with a Retry button.
- Share: a "Share" button after an app is done → `POST /api/apps/:id/share` → copy the full URL (`location.origin + url`) to the clipboard, a toast "Link copied", and quick buttons "Post on X" (an intent URL with the text "I made this with one sentence on Blink ⚡ #KimiOnCerebras" plus the link) and "Open".
- `/?remix=<id>`: load the app (`GET /api/apps/:id`, preview from `/raw/:id`), show it as the current app, focus the Remix input; remixes send `remixOf`.
- `/gallery`: the gallery page (the same grid, full page). The server must serve `index.html` for `/gallery` (Task A: add an SPA fallback for `/gallery`).
- Mobile: everything usable at 375px wide (the grid becomes a single column; the preview height adapts).
- Keep race mode working.
- Tests: event handling for variants and queue, share URL building, remix query parsing.

## Claude (operations)

`brew install cloudflared`, a quick tunnel to `http://127.0.0.1:5173`, `BLINK_PUBLIC_ORIGIN` set to the tunnel URL, keep-awake, `scripts/start-prod.sh`, a live smoke test from a phone-width viewport, then updated posts.
