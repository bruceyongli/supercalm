# Contributing to Supercalm

Thanks for your interest! Supercalm is a small, dependency-light project with a deliberate house style.
A few things will make contributions land smoothly.

## Ground rules

- **Vanilla Node, no framework.** `node:http` + a tiny router in `src/server.js`; `node:sqlite`
  (built in) in `src/store.js`. ESM (`"type": "module"`). Keep runtime dependencies sparse — the only
  ones are `web-push` and the `@ag-ui/*` packages. Don't add a framework or a build step.
- **Frontend is plain HTML/CSS/JS** in `web/` (dark, monospace, mobile-first). xterm.js is vendored in
  `web/vendor/`. Shared helpers in `web/common.js`.
- **Match the surrounding code** — comment density, naming, and idiom. Read the file before editing it.
- **UI principle:** don't add visible controls for rare edge cases unless asked. Prefer automatic
  behavior and progressive fallback; keep the console low-brain-load.

## Development

```sh
npm install
cp .env.example .env      # then set what differs for your setup (all optional; see src/config.js)
npm test                  # the full suite must stay green
npm run dev               # node --watch src/server.js  (http://127.0.0.1:8793)
```

- **Tests:** `npm test` runs the whole suite (unit tests over the router, store, detectors, and the
  supervisor decision engine). Add a test for behavior changes — the supervisor especially has a replay
  harness (`test/supervisor_replay.test.js` + fixtures) that locks its decisions.
- **No secrets, ever.** Everything sensitive is env/config or gitignored under `data/`. Don't hardcode
  hostnames, IPs, keys, or personal paths — thread them through `src/config.js` / env with a default.

## Pull requests

- Keep PRs focused; explain the why. Reference `file:line` where helpful.
- Run `npm test` and note the result.
- For anything security-relevant, read `SECURITY.md` first.

## Architecture pointers

`README.md` has the map. The load-bearing modules: `src/server.js` (router), `src/sessions.js` (tmux
lifecycle), `src/detect.js` (working/waiting classifier), `src/store.js` (sqlite), and
`src/agents/supervisor/` (the stage-aware decision engine). The `docs/` directory has deeper design and
architecture notes.
