# Agent View QA Evidence

Date: 2026-06-11
Updated: 2026-06-12

Local QA server: `http://127.0.0.1:8796`

Test session: `s_2f162d9317`

## Automated Checks

- `npm run test:agui`: passed.
- `node --check src/agui_session.js`: passed.
- `node --check src/sessions.js`: passed.
- `node --check web/session.js`: passed.
- `node --check web/agent_view.js`: passed.
- `GET /api/session/s_2f162d9317/agui`: returned 48 groups and 387 AG-UI events after the latest request.
- `GET /api/session/s_2f162d9317/timeline`: returned 157 blocks; existing Conversation API still works.

## Browser Evidence

Screenshots are in `test-results/agent-view/`.

- `iteration3-terminal-default.png`: Terminal view default load.
- `iteration4-desktop-agent.png`: desktop Agent View after debug details were demoted.
- `iteration4-mobile-390-agent.png`: 390px Agent View with request cards, compact debug drawer, and visible attachment/mic/send controls.
- `fallback-conversation-desktop.png`: existing Conversation view still renders.
- `live-8793-fallback-agent.png`: live failing server on port 8793 recovered from `/agui` 404 through the Timeline fallback and rendered the Agent View.
- `live-8793-fallback-mobile-390.png`: same live fallback path at 390px width.
- `live-8793-terminal-scroll-top.png`: Terminal view after the scrollback replay fix, scrolled to the oldest available tmux history.
- `live-8793-terminal-scroll-bottom.png`: Terminal view after the same fix, at latest output.

Metrics:

- `browser-metrics-iteration4.json`
  - Default Terminal load: `agentFetched=false`, `termHidden=false`, `agentHidden=true`.
  - Desktop Agent View: `hasAgent=true`, `agentFetched=true`, `aguiFetched=true`, `groups=48`, `rawTopRows=0`, `sideVisible=true`, `overflow=false`.
  - 390px Agent View: `hasAgent=true`, `agentFetched=true`, `aguiFetched=true`, `overflow=false`, `clippedComposer=false`, attachment/mic/send visible, `smallestTap=30`.
- `mobile-cdp-metrics.json`
  - 390px and 430px widths: document/body width matched viewport, no Agent root overflow, composer not clipped, side panel stacked below main, attachment/mic/send visible.

Live fallback regression check, 2026-06-12:

- `GET http://127.0.0.1:8793/api/session/s_2f162d9317/agui`: `404`, body `not found`.
- `GET http://127.0.0.1:8793/api/session/s_2f162d9317/timeline`: `200`, `ok=true`, `164` blocks.
- Live browser probe at `http://127.0.0.1:8793/aios/session?id=s_2f162d9317&view=agent`: `failed=false`, `overview=true`, `groups=51`, `openGroups=1`.
- Live 390px browser probe: `failed=false`, `overview=true`, `groups=51`, `overflowX=0`, `composerBottom=844`, `viewportHeight=844`.
- This proves the Agent tab no longer fails closed when the frontend is newer than the running backend route set.

Terminal scrollback regression check, 2026-06-12:

- Root cause: initial Terminal replay used a raw tail of `data/logs/s_2f162d9317.log`; that 187MB log contains more than 24M ANSI escape bytes and more than 224K `CSI 47;2H` cursor-positioning sequences. Replaying from an arbitrary byte offset can start mid-escape and render fragments like `[47;2H`.
- Second root cause: Codex emits `CSI 3J`, which tells xterm to erase scrollback. The log contains hundreds of these clear-history commands.
- Server fix: `/api/session/:id/stream` now initializes new viewers from `tmux capture-pane` plain-text history instead of raw pipe-log bytes.
- Browser fix: the web Terminal filters only `CSI 3J` clear-scrollback commands before writing stream data to xterm; normal screen redraws still render.
- Live stream first event after restart: `71,336` bytes, `0` ANSI escape bytes, no `CSI 3J`.
- Live browser probe at Terminal view: loaded `baseY=1421`; after `window.__aiosScrollTop()`, `viewportY=0`, `bottomDistance=1421`, `blankRows=11`, and first non-empty visible row was real command output instead of a raw cursor fragment.
- Limitation: the currently running tmux pane only exposes about `1325` history lines because earlier clear-history commands already affected the pane. The fix preserves readable scrollback going forward and restores the oldest history tmux still has; it does not reconstruct old terminal history from the raw ANSI log.

## Performance Evidence

- Installed `node_modules/@ag-ui`: 2.3 MB unpacked.
- Installed AG-UI package tree:
  - `@ag-ui/client`: 616 KB unpacked.
  - `@ag-ui/core`: 1.1 MB unpacked.
  - transitive `@ag-ui/encoder`: 76 KB unpacked.
  - transitive `@ag-ui/proto`: 536 KB unpacked.
- Static file sizes:
  - `web/agent_view.js`: 32,442 bytes raw, 8,686 bytes gzip after adding the Timeline fallback adapter.
  - `web/session.js`: 82,477 bytes raw, 21,566 bytes gzip.
  - `web/styles.css`: 61,924 bytes raw, 10,498 bytes gzip.
- Lazy-load evidence: default Terminal browser load did not request `agent_view.js`.

## License And Fallback Evidence

- `@ag-ui/core` and `@ag-ui/client` package metadata does not include a `license` field, but installed `LICENSE` files for `@ag-ui/core`, `@ag-ui/client`, `@ag-ui/encoder`, and `@ag-ui/proto` are MIT.
- `GET /api/session/does-not-exist/agui` returns `404` JSON: `{"error":"no such session"}`.
- Agent View runtime errors show a scoped error state with a retry button instead of leaving the panel in an indefinite loading state.
- If `/api/session/:id/agui` is missing but `/api/session/:id/timeline` is healthy, `web/agent_view.js` now builds the same request-first Agent View payload client-side from Timeline blocks before showing an error state.

## Proxy Critique Applied

Proxy critique requested:

- Keep desktop side rail visible: kept.
- Move AG-UI/source rows under an advanced/debug drawer: applied as `Debug details`.
- Improve side panel narrative content: applied selected-request evidence, latest changes, and terminal summary.
- Keep paperclip/voice/send visible on mobile: attachment/mic/send controls verified visible at 390px.
- Reduce mobile vertical density: tightened mobile Agent rows and composer spacing while preserving 30px minimum tap target.
- Avoid indefinite loading: Agent View API load now has a 20-second timeout and a retry button only in the error state.

## Residual Risk

- Mobile side panel stacks below the composer and is reachable by shell scroll, but it is not simultaneously visible with the active request. This follows the current Supercalm mobile layout pattern, but it is still less persistent than desktop.
- The browser QA used Chrome DevTools Protocol and system Chrome rather than Playwright because adding Playwright would violate the dependency gate for this phase.
