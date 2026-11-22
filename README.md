# Blink

**Think it. Blink it.** Type one sentence and get a working web app or game. The code streams in live and the app runs the moment it's done.

Blink runs Kimi K3.1 Pro on Cerebras through an [OpenClaw](https://openclaw.ai) agent. Cerebras writes a full 4,000–6,000-token app in seconds, so you can iterate as fast as you think: remix the app in plain English ("make it night mode", "add a high score") and it rebuilds instantly.

## How it works

```
Browser ──► Blink server (/api/generate, SSE) ──► OpenClaw gateway /v1/chat/completions
                                                     └─► agent "blink" ──► Kimi K3.1 Pro on Cerebras
```

- The `blink` OpenClaw agent has no tools and follows [agent/AGENTS.md](agent/AGENTS.md): reply with one self-contained HTML file.
- The Blink server streams the agent's reply to the browser and measures time to first token, total time, tokens and tok/s.
- The browser shows the code as it streams, and runs the app in a sandboxed iframe (`sandbox="allow-scripts"`) as soon as `</html>` arrives.
- Remix sends the change plus the current app, in the same OpenClaw conversation.
- An optional Race mode streams the same prompt to a second OpenAI-compatible provider side by side (see below).

## Run it

Requires Node 24 and OpenClaw with Kimi K3.1 Pro on Cerebras configured.

1. Set up the OpenClaw agent (one time):

   ```bash
   mkdir -p ~/.openclaw/workspace-blink
   openclaw agents add blink --workspace ~/.openclaw/workspace-blink --model cerebras/moonshotai-kimi-k3.1-pro-trial --non-interactive
   cp agent/AGENTS.md ~/.openclaw/workspace-blink/AGENTS.md
   rm -f ~/.openclaw/workspace-blink/BOOTSTRAP.md
   openclaw config set agents.entries.blink.tools.deny '["*","tool_search","tool_describe","dispatch_action","tool_call"]' --strict-json
   openclaw config set gateway.http.endpoints.chatCompletions.enabled true
   ```

2. Start the gateway: `openclaw gateway --port 18789 --bind loopback`.
3. Create `.env` with `OPENCLAW_BASE_URL=http://127.0.0.1:18789`, `OPENCLAW_GATEWAY_TOKEN=<your gateway token>` and `MAX_OUTPUT_TOKENS=16000` (Kimi's reasoning tokens count toward the output limit, so a full game can use 14K).
4. Build and start Blink:

   ```bash
   npm install
   npm run build
   set -a; . ./.env; set +a; npm start
   ```

5. Open http://127.0.0.1:5173.

### Race mode (optional)

Set `COMPARE_BASE_URL`, `COMPARE_API_KEY`, `COMPARE_MODEL` and `COMPARE_LABEL` (any OpenAI-compatible provider, for example a GPU host) and restart. A Race toggle appears, and both lanes get the same prompt at the same moment.

## Public hosting

`scripts/start-prod.sh` starts the OpenClaw gateway (loopback only), a Cloudflare tunnel and Blink, kept awake with `caffeinate`. With a named tunnel `blink` routed to your hostname (`cloudflared tunnel create blink`, `cloudflared tunnel route dns blink <host>`) the URL is permanent; otherwise it falls back to a temporary quick tunnel, which buffers streaming and is for testing only. Abuse controls: per-browser creator cookies, per-IP (IPv6 /64) hourly limits, a fair queue, a shared request and token budget matched to the Cerebras quota, CSP-sandboxed app serving, and report-based moderation (`ADMIN_TOKEN` enables the hide API).

## Scripts

- `npm run dev`: Vite on 5173 with `/api` proxied to the server on 5174.
- `npm run build`: builds the frontend into `dist/web`.
- `npm start`: serves `dist/web` and the API on `PORT` (default 5173).
- `npm test`: unit and server tests (Node's test runner via tsx).

Built for the Cerebras × Kimi K3.1 Pro × OpenClaw hackathon. #KimiOnCerebras
