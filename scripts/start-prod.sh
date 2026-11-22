#!/bin/zsh
# Runs Blink publicly from this Mac: OpenClaw gateway (loopback only), a
# Cloudflare quick tunnel, and the Blink server, all kept awake by caffeinate.
# Usage: scripts/start-prod.sh        (Ctrl-C stops Blink and the tunnel)
set -eu
ROOT=${0:A:h:h}
cd "$ROOT"
mkdir -p data logs
source ~/.zshrc >/dev/null 2>&1 || true
set -a; . ./.env; set +a

# 1. OpenClaw gateway on loopback (left running if already up).
if ! curl -s -o /dev/null http://127.0.0.1:18789/; then
  echo "Starting the OpenClaw gateway..."
  nohup openclaw gateway --port 18789 --bind loopback >> logs/gateway.log 2>&1 &
  for i in {1..60}; do curl -s -o /dev/null http://127.0.0.1:18789/ && break; sleep 2; done
fi
curl -s -o /dev/null http://127.0.0.1:18789/ || { echo "Gateway didn't start; see logs/gateway.log"; exit 1; }

# 2. Cloudflare tunnel to Blink.
#    With a named tunnel (BLINK_TUNNEL, default "blink", created with
#    `cloudflared tunnel create` and routed to BLINK_HOSTNAME), the URL is
#    permanent and streaming works. Otherwise a quick tunnel is used: its URL
#    changes on every run and it buffers responses, so it's for testing only.
: > logs/tunnel.log
TUNNEL=${BLINK_TUNNEL:-blink}
HOSTNAME_PUBLIC=${BLINK_HOSTNAME:-blink.yashkhurana.dev}
if cloudflared tunnel info "$TUNNEL" >/dev/null 2>&1; then
  cloudflared tunnel --no-autoupdate run --url http://127.0.0.1:5173 "$TUNNEL" >> logs/tunnel.log 2>&1 &
  TUNNEL_PID=$!
  URL="https://$HOSTNAME_PUBLIC"
  for i in {1..30}; do grep -q 'Registered tunnel connection' logs/tunnel.log && break; sleep 1; done
  grep -q 'Registered tunnel connection' logs/tunnel.log || { echo "Named tunnel didn't connect; see logs/tunnel.log"; kill $TUNNEL_PID; exit 1; }
else
  echo "No named tunnel '$TUNNEL' found; using a temporary quick tunnel (testing only)."
  cloudflared tunnel --no-autoupdate --url http://127.0.0.1:5173 >> logs/tunnel.log 2>&1 &
  TUNNEL_PID=$!
  URL=""
  for i in {1..60}; do
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' logs/tunnel.log | head -1 || true)
    [ -n "$URL" ] && break; sleep 1
  done
  [ -n "$URL" ] || { echo "Tunnel didn't start; see logs/tunnel.log"; kill $TUNNEL_PID; exit 1; }
fi
echo "$URL" > data/public-url
echo "Public URL: $URL"

# 3. Blink (built frontend), bound to loopback; the tunnel is the only way in.
npm run build >/dev/null
export BLINK_PUBLIC_ORIGIN="$URL" PORT=5173
trap 'kill $TUNNEL_PID 2>/dev/null' EXIT INT TERM
caffeinate -is npm start 2>&1 | tee -a logs/blink.log
