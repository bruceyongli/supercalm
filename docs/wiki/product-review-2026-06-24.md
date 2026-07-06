# Supercalm Product Review

_Review date: 2026-06-24_

## Scope

Reviewed the running Supercalm service at `0.1.155`, the current repo, and the recent Council recommendation in `docs/wiki/council/recommended-aios-work.md`.

Surfaces inspected:

- Dashboard: `/aios/`
- Session page with Supervisor side panel: `/aios/session?id=s_c7c58ecd50&sideTab=supervisor`
- Auth / tools / models: `/aios/auth`
- Usage: `/aios/usage`
- Records: `/aios/records`
- Decisions: `/aios/decisions`
- Core APIs: `/api/version`, `/healthz`, `/api/state`, `/api/auth/status`, `/api/agents`, `/api/tools/versions`, `/api/project/p_cf486ec06f/graph/impact`, `/api/records`, `/api/decisions`

## Product Read

Supercalm is already a useful operator console, not just a launcher. The strongest surfaces are:

- Dashboard: a compact live control room for waiting, working, and exited sessions.
- Session page: terminal, composer, session rail, and agent side tabs can all coexist on desktop.
- Supervisor: meaningful autonomous verification loop with review history, screenshots, and an explicit held/escalated state.
- Usage: cost/quota/top-burner information is immediately actionable.
- Records and Decisions: strong audit trail for operator memory and future training data.
- Project Graph Phase 1: useful backend evidence path for changed files, affected routes/tools/agents, stale status, and confidence labels.

The weak points are mostly operational polish:

- There is no single first-party "is Supercalm healthy?" product page/API for version, auth, live session counts, tool versions, graph freshness, and stale reasons.
- Verification is still tribal: agents run individual tests manually instead of one canonical `npm test`.
- Project Graph is useful but still needs audit polish so agents can trust exactly when each fact was extracted.
- Some operator docs drifted behind shipped behavior.

## Confirmed Bugs

1. Static file confinement used a weak prefix check.
   - File: `src/server.js`
   - Evidence: `normalize(join(WEB_DIR, '/../web2/secret.txt')).startsWith(WEB_DIR)` returned `true`, so a sibling path sharing the `web` prefix could pass the guard.
   - Fix landed in this review: `src/static_path.js` adds a `relative()`-based boundary check and `test/static_path.test.js` covers traversal cases.

2. Project Graph indexed test fixture `route()` calls as real product routes.
   - File: `src/project_graph_core.js`
   - Evidence: live `changed_impact` included `route:GET:/healthz` from `test/project_graph.test.js`.
   - Fix landed in this review: route extraction now only treats `src/**` runtime source files as product routes; `test/project_graph.test.js` includes a test-only `route('DELETE', '/fixture-only')` fixture that must not appear.

3. README / agent notes drifted from deployed reality.
   - Files: `README.md`, `CLAUDE.md`
   - Evidence: README still named the old direct `:8793` URL as primary, mentioned rsync fallback, and claimed `web-push` was the only npm dependency even though Agent View uses `@ag-ui/*`.
   - Fix landed in this review: README now points to `/aios`, describes git-only deploy, and documents the small actual dependency set; `CLAUDE.md` matches the dependency note.

## Not Bugs

- Auth page first render can look incomplete at short waits, but `/api/auth/status` returned `200` quickly with `mode=proxy`, `proxyUp=true`, and all three providers logged in. A 10-second rendered capture showed the Auth page settled correctly. This is a UX latency/presentation improvement, not a credential bug.
- Version bump workflow is fixed: `bin/deploy` calls `bin/version`, requires a clean tree, and aborts if the version does not change.
- Council capture has the right backend shape now: captured wiki outcomes write real files under `docs/wiki/council/` when the project path is writable and return per-destination status.

## Top 3 Improvements

1. Canonical verification command.
   - Problem: verification evidence is scattered across hand-run commands.
   - Work: add npm scripts so `npm test` runs the current focused suites, including static path and project graph checks.
   - Why first: every future bug fix and deploy gets clearer evidence.

2. Product health snapshot.
   - Problem: operators and Supervisor need one endpoint/page for "what is healthy right now?"
   - Work: add a compact health API and page covering version, uptime, auth mode/provider login, session counts, project graph freshness, and top issues.
   - Why second: reduces repeated manual API probing after deploys, reboots, and auth incidents.

3. Project Graph audit polish.
   - Problem: graph facts are useful but should expose extraction timing in the API, not only internal `updated_at` names.
   - Work: expose `extracted_at` for graph nodes/edges and keep test fixture routes excluded.
   - Why third: improves Supervisor/Preflight trust without expanding into heuristic code intelligence.

## Verification Evidence

- `curl /api/version` returned `0.1.155` before this review work.
- `/healthz` returned `{ ok: true, service: "aios", version: "0.1.155" }`.
- `/api/auth/status` returned `mode=proxy`, `proxyUp=true`, and `claude/codex/antigravity` logged in.
- `/api/tools/versions` returned Claude `2.1.190`, Codex `0.142.0`, Antigravity `1.0.11`, 54 scanned models.
- `/api/records?limit=5` and `/api/decisions?limit=5` returned recent live records, including this review request.
- Rendered screenshots were captured for dashboard, session/Supervisor, auth, usage, records, and decisions with `bin/shot.mjs`.

## Immediate Follow-Through

- Bugs fixed first in this branch.
- Top-three improvements implemented in this branch:
  - `npm test` now runs static-path, project-graph, and AG-UI checks.
  - `/api/product/health` and `/aios/health` provide the operator health snapshot.
  - Project Graph API responses expose `extracted_at` for nodes, edges, and affected surfaces.
- Full verification and deploy evidence should be attached to the final handoff.
