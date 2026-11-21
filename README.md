# Blink

Blink turns a sentence into a mini web app or game, using Kimi on Cerebras through OpenClaw. This scaffold contains a vanilla TypeScript frontend and a Node HTTP server; generation features come later.

Requires Node 24. Install dependencies with `npm install`.

- `npm run dev`: starts Vite at http://localhost:5173 and the server on port 5174, with `/api` proxied to the server.
- `npm run build`: builds the frontend into `dist/web`.
- `npm start`: serves `dist/web` on `PORT` (default 5173). Unknown `/api` routes return JSON with status 404. Run the build first.
- `npm test`: runs Node's test runner through tsx for server and frontend tests.
