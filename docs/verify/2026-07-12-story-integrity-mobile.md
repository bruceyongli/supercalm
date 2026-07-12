# Verification checkpoint — story integrity + speed + supervisor + mobile default

**Build: v0.3.112.** Committed review artifact for the operator's requests this round (story surface,
switching speed, supervisor task-flow, and the desktop story view as the mobile default). Rendered PNGs
were captured to `/tmp/*.png` during verification (ephemeral binaries — not committed); this doc is the
durable index of the fixes + the reproducible command/query evidence behind them.

## Operator visual corrections — fix / deferral record
| Correction (operator's own words / screenshots) | Status | Inspectable evidence |
|---|---|---|
| "This session never generated a story … should generate no matter what" (`s_8ea0dbf260`, empty `❯` rows) | **FIXED** v0.3.105 `c809872` | `GET /api/session/s_8ea0dbf260/story` → `source:fallback, count 25, 21 real operator turns, 0 detect/placeholder noise`. Rendered `/tmp/story-final.png`. |
| "Stop hook feedback:" shown as the operator's own bubble | **FIXED** v0.3.105 | `story.js cleanUserText` drops `… hook feedback` / `<…-hook>` user-role turns; `test/story_spine.test.js` source-locks it; regex spared a real message that merely mentions the words. |
| "I already chose the option card, and it bounced back to the selection UI" | **FIXED** v0.3.105 | client-side sticky `answeredAsks` in `web/story-view.js` (survives the SSE re-render); source-locked in `test/story_spine.test.js`. |
| "make our desktop story view the default for mobile, maybe a bit optimized" | **FIXED** v0.3.109 `d59d34a` + v0.3.110 `5b971ef` | Playwright: `default→DESKTOP-SESSION`, header `modelChipHidden:true`, `0 pageerrors`; `?phone=1→PHONE`, `?desktop=1→DESKTOP-SESSION`. Rendered `/tmp/mobile-final.png`. |
| "compact the header … hide/shorten the model chip" | **FIXED** v0.3.110 | model·effort·autonomy `.badge` inside `#s-title` hidden at ≤600px (verified by `getComputedStyle`), title truncates, short status kept. |
| "how to switch to mobile/phone view" (no discoverable control) | **FIXED** v0.3.111 | mobile-only "📱 phone view" pill (`web/shell.js` + `desktop.css`) + `?phone=1`, both preserving the current URL. |
| Mobile dashboard cramped (desktop sidebar on a phone) → **Option A** | **FIXED** v0.3.112 `309870c` | dashboard→phone triage on mobile; session→desktop story; phone triage cards→desktop session (`web/{desktop,index,session}.html`, `web/phone.js`). Playwright: `dashboard→PHONE · tap-session→DESKTOP-STORY · direct-session→DESKTOP-STORY · ?phone=1→PHONE`. Screenshot `/tmp/aflow-dash.png`. |
| Right panel collapsed on mobile | **DEFERRED** | `#session-usage-panel` / `web/agents/*` is a standing operator carve-out ("untouched"); needs the operator's direct word. Visual test showed it isn't hurting the story-first layout, so it's left stacked-below. |

## Story-load / source surface (the corrected mechanism)
The guaranteed story now reconstructs from AIOS's own `messages` table (real text), attributed by the
`source` column via the pure module `src/story_spine.js`:
- operator sources (`text`/`task`/`voice`/…) → `you` bubble with real text;
- `out|detect` terminal snapshots → dropped (the "request failed 405" / gcm noise);
- `agent:*` / supervisor injections → dropped or labeled, never a fake operator bubble.
`test/story_spine.test.js` → **all assertions passed** (attribution per source class + wiring source-locks).

## Also shipped this round (evidence)
- **Instant load** v0.3.106 `b559378` — sessionStorage story cache + hover prefetch (`web/story-view.js`, `web/shell.js`).
- **Supervisor full-auto card task-flow on operator messages** v0.3.107 `1938061` — `src/agents/supervisor.js`; `test/supervisor_on_message.test.js` **passed** (create→activate→amend chain + guard scoping + boot bound). Boot-guard: 0 operator card-events since deploy.
- **True in-place session switch** v0.3.108 `e303e0a` — `web/session.js`; Playwright: single + 4× back-and-forth switches, `noReload=true`, `full-document-reloads=0` (via `page.on('load')`), median 163ms, `dups=[]`, 0 errors.

## Unresolved proof gaps / current risk (NOT claimed done)
1. **Supervisor Part 3 live LLM classify** — code path unit-verified; the live classification is
   **externally blocked** by a fleet-wide "session usage limit reached" (all models). Recheck when it clears.
2. **Right-panel graph-interval cleanup** — a ~6-line `destroy()` patch is staged but **UNAPPLIED**;
   `git diff -- web/agents/` is empty (fence intact). Blocked on the operator's direct word to touch the
   carved-out panel, per the standing "untouched" constraint. Bounded/harmless residual meanwhile.
