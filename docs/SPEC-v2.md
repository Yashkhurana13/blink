# Blink v2: public product spec

Status: approved by the user on 2026-11-22 (hosting: this Mac behind a public tunnel; features: share links, 4 variations, public gallery, fair queue). Extends [SPEC.md](SPEC.md); where they differ, this file wins.

## Goal

Real people open a public URL, make apps, share them, and browse what others made, without Blink breaking under load or being abused. Shared apps drive reach on X and Reddit.

## Constraints

- One Cerebras key: 100 requests and 100K tokens per minute, shared by every user. One app is about 4–6K tokens. The trial API ends Mon 23 Nov 11:30 PM IST; after that Blink shows a clear "paused" message (the upstream errors become a friendly message, not a crash).
- Cerebras sometimes queues requests for 30–60+ seconds, or stops answering for minutes.
- Hosted on this Mac: Blink (port 5173) is exposed through a Cloudflare Tunnel. The OpenClaw gateway stays on loopback and is never exposed.

## Features

1. **Generate** (existing): one sentence → a complete app, streamed, with a live preview and stats.
2. **4 variations**: a "×4" toggle sends the same idea as 4 parallel generations, each told to take a different creative direction. A 2×2 grid shows them streaming; clicking one makes it the main app (for remix, share and download).
3. **Remix** (existing): change the selected app in plain English.
4. **Share links**: every finished app is saved. "Share" makes it public and copies `https://<host>/a/<id>`. The share page shows the app full-size, its prompt, a "Make your own" button, and "Remix this" (opens Blink with that app loaded). It has Open Graph and Twitter card tags (title from the app's `<title>`, the prompt as the description, a static Blink card image).
5. **Public gallery**: on the home page and at `/gallery`, the newest shared apps as cards (title, prompt, live mini preview on hover/tap, open link). Only apps the creator chose to share appear there.
6. **Fair queue and status**: the server limits concurrent upstream generations and queues the rest. The UI shows "You're #3 in line", then "Waiting for Cerebras…" (with elapsed seconds), then streaming. Each user gets at most one active run and a per-hour cap. If the queue is full, users see a friendly "Blink is very busy" with a retry.
7. **Report and moderation**: a "Report" link on share pages. Reported apps are hidden from the gallery after 3 reports. An admin token (`ADMIN_TOKEN`) can hide any app via the API.

## Security requirements

- Generated apps are untrusted code. They're always served from `/raw/<id>` with `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:` and `X-Content-Type-Options: nosniff`, so even when opened directly they get an opaque origin and can't make network requests. The share page embeds `/raw/<id>` in `<iframe sandbox="allow-scripts">`.
- The client IP comes from `CF-Connecting-IP` only when the TCP peer is loopback (the tunnel); otherwise from the socket. Raw IPs are never stored; store a salted hash.
- Input limits: prompt ≤ 500 characters for new apps and remixes; `currentHtml` ≤ 200 KB and must be an app this server produced (send its `appId`; the server loads the HTML itself instead of trusting the client).
- Existing protections stay: loopback binding by default (the tunnel connects to loopback), JSON-only POSTs, origin checks (the public origin is added through `BLINK_PUBLIC_ORIGIN`).
- No secrets reach the browser. Logs never include tokens.

## Out of scope

Accounts, likes and comments, editing apps by hand, custom domains (the tunnel URL is the address), image generation.
