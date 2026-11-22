# Blink: demo video and posts

Submissions close **Sunday 22 Nov, 11:30 PM IST (10:00 AM PT)**. Record the demo with standard OpenClaw (port 18789), not the speed-patched build.

## What the demo should prove

Blink isn't "v0 but faster": **one sentence gives you four different working apps, side by side, in about 30 seconds.** GPU-backed tools take that long for one. That's the hook, so build the video around the ×4 grid.

Measured on this Mac (Sunday afternoon), "Pomodoro timer with a fox that sleeps" ×4:

| Variant | App | Speed | Total | Tokens |
|---|---|---|---|---|
| Classic | Still | 626 tok/s | 25.0 s | 10,091 |
| Bold | Sleepy Fox | 751 tok/s | 37.2 s | 13,629 |
| Minimal | foxtail | 590 tok/s | 19.3 s | 7,529 |
| Retro | Napdoro | 637 tok/s | 24.2 s | 8,044 |

That's 39,293 tokens across four complete apps, all in parallel. The tok/s figures are measured by Blink after relaying through OpenClaw, and the totals include Cerebras queue time.

## Before recording

- Record off-peak if possible. At peak times Cerebras queued each request for 15–60 seconds before the first token. Queue time doesn't change generation speed, but it makes the wait longer.
- Check that both are running: the standard gateway (`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18789/` prints 200) and Blink (`http://127.0.0.1:5173`).
- To start Blink locally: `cd ~/Hackathon/blink && set -a; . ./.env; set +a; npm start`. To run it publicly: `scripts/start-prod.sh` (after the Cloudflare tunnel exists).
- Hide notifications, bookmarks and other tabs. Nothing from `.env` should be on screen.
- Optional: for a GPU side-by-side, set the `COMPARE_*` variables to a provider you have a key for and use Race mode. Blink never fakes the second lane.

## 60-second shot list

1. **(0–4 s) Hook.** The home screen with "Think it. Blink it." Caption: "One sentence. Four apps."
2. **(4–8 s) Prompt.** Turn on **×4 variations**, click "Pomodoro timer with a fox that sleeps" (or type your own idea) and press Blink.
3. **(8–28 s) The money shot.** The 2×2 grid: four previews filling in at once, each with its own live tok/s. Speed up only the "Waiting for Cerebras" seconds and label them ("queue, sped up"). Keep the generation itself at real speed.
4. **(28–36 s) Pick.** Hover over the four finished apps (Still, Sleepy Fox, foxtail, Napdoro) and click "Use this one" on the retro one.
5. **(36–46 s) Remix.** Type "add a streak counter and make the fox snore" and watch it rebuild.
6. **(46–54 s) Share.** Click Share, then open the link: the share page with the app full size and "Remix this". Flash the gallery.
7. **(54–60 s) End card.** "Blink: Kimi K3.1 Pro on Cerebras, via OpenClaw. #KimiOnCerebras", plus the repo or site URL.

## X post (required, the official entry)

```
Blink ⚡ One sentence → four working apps, side by side, in ~30 seconds.

Pick your favourite, remix it in plain English, share the link. Every app is a real, playable single-file web app.

Kimi K3.1 Pro on @Cerebras via OpenClaw. @Kimi_Moonshot #KimiOnCerebras

Team: <your X handle>
Code: https://github.com/Yashkhurana13/blink
```

When Blink is live, add `Try it: https://blink.yashkhurana.dev` as the second-to-last line. Every share link people post from Blink shows a Blink preview card on X, which brings more people in.

## Reddit (r/cerebras, flair "Kimi K3.1 Pro Hackathon")

Title: `Blink: one sentence → four working web apps side by side in ~30s (Kimi K3.1 Pro on Cerebras via OpenClaw)`

```
I built Blink for the hackathon. You type an idea ("pomodoro timer with a fox that sleeps") and an OpenClaw agent running Kimi K3.1 Pro on Cerebras writes four complete, different single-file apps in parallel: classic, bold, minimal and retro. In my test that was ~39K tokens across four apps in under 40 seconds, at 590–750 tok/s each. You pick one, remix it in plain English, and share it with a link; shared apps show up in a community gallery.

How it works:
- A Node server streams from the OpenClaw gateway's OpenAI-compatible endpoint. The agent has no tools, just one instruction file.
- Apps run sandboxed, with a CSP that blocks all network access, so shared apps can't phone home.
- A fair queue and a shared token budget keep it working under load on a single API key (100K tokens per minute).

Demo video attached. Code: https://github.com/Yashkhurana13/blink. Happy to answer questions about the queue or the sandboxing.
```

## GitHub

Public repo: https://github.com/Yashkhurana13/blink (branch `main`). `.env` is gitignored and was never committed.
