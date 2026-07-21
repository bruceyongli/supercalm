---
name: verify
summary: Runtime verification recipe for Supercalm UI/server changes
---

# Supercalm runtime verification

1. Boot an isolated worktree server: `AIOS_DATA=$(mktemp -d) AIOS_PORT=<free> AIOS_PROXY_KEY=invalid AIOS_FLEET_OVERVIEW_PORT=1 AIOS_CLAUDE_PROXY_URL=http://127.0.0.1:1 node src/server.js`.
2. Launch a throwaway session against that port with `POST /api/session`; never reuse production `:8793` data.
3. For shared session-shell geometry, run `AIOS_UI_LAB_BASE=http://127.0.0.1:<port> AIOS_UI_LAB_VISION=0 npm run ui-lab -- session-sidebar-collapse`.
4. Drive adjacent GUI states with Playwright from the repo devDependency: desktop >1194px, compact ≤1194px, reload persistence, rapid toggles, and a non-session shell page. Capture screenshot(s) under `/tmp` or `data/ui-lab`.
5. Kill the throwaway session, server PID/port, and temp data/project dirs.

Gotchas: `ui-lab` discovers live sessions; the collapse scenario accepts any live session (no supervisor card required). Always point `AIOS_UI_LAB_BASE` at the worktree server or you will verify production’s older CSS instead.
