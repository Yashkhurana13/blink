# Blink: demo video and posts

Submissions close **Sunday 22 Nov, 11:30 PM IST (10:00 AM PT)**. Record the demo with standard OpenClaw (port 18789), not the speed-patched build.

## Before recording

- Record off-peak if possible. At peak times Cerebras queued each request for about 50 seconds before the first token. That kills a "blink" demo, even though generation itself is fast.
- Check that both are running: the standard gateway (`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18789/` prints 200) and Blink (`http://127.0.0.1:5173`).
- To start Blink: `cd ~/Hackathon/blink && set -a; . ./.env; set +a; npm start`.
- Hide notifications, bookmarks and other tabs. Nothing from `.env` should be on screen.
- Optional, for the recommended side-by-side: set the `COMPARE_*` variables to a GPU provider you have a key for, and use Race mode. Blink never fakes the second lane.

## 60-second shot list

1. (0–5 s) Blink's home screen: "Think it. Blink it."
2. (5–25 s) Type "Neon snake with a rainbow trail", or click the chip, and press Blink. The code pours in; the preview turns into the game; the stats bar shows the tokens and time.
3. (25–35 s) Play the game for a few seconds.
4. (35–50 s) Remix: "make the snake leave fireworks when it eats". The app rebuilds.
5. (50–60 s) End card: "Kimi K3.1 Pro on Cerebras, via OpenClaw. #KimiOnCerebras".

Speed up only the wait before the first token, and label it ("queue, sped up"). Keep the streaming itself at real speed, because that's what shows Cerebras.

## X post (required, the official entry)

```
Blink ⚡ Type one sentence, get a working app in seconds.

The code streams in at Cerebras speed, the app runs the instant it's done, and you remix it in plain English.

Built on OpenClaw with Kimi K3.1 Pro on @Cerebras. @Kimi_Moonshot #KimiOnCerebras

Team: <your X handle>
Code: <GitHub link>
```

## Reddit (r/cerebras, flair "Kimi K3.1 Pro Hackathon")

Title: `Blink: one sentence → a working web app in seconds (Kimi K3.1 Pro on Cerebras via OpenClaw)`

```
I built Blink for the hackathon. You type an idea ("neon snake with a rainbow trail", "pomodoro timer with a sleepy fox") and an OpenClaw agent running Kimi K3.1 Pro on Cerebras writes a complete single-file app. You watch the code stream in and the app runs the moment it's done, usually 4–6K tokens in a few seconds of generation. Then you remix it in plain English.

How it works: a small Node server streams from the OpenClaw gateway's OpenAI-compatible endpoint to the browser, and the app runs in a sandboxed iframe. The agent has no tools, just one instruction file.

Demo video attached. Code: <GitHub link>. Happy to answer questions.
```

## GitHub (recommended)

The repo is local only (`~/Hackathon/blink`, branch `main`). To publish it, create a public repo and push. Claude didn't do this because publishing is your call. Check that `.env` isn't included (it's in `.gitignore`).
