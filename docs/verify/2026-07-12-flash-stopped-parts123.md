# Verify — supervisor-doc flash, sidebar stopped-sessions, Parts 1–3 live (2026-07-12)

Committed record for the operator-reported fixes shipped as **v0.3.116** (fixes) + **v0.3.117**
(regression guard), plus a fresh live re-run of the broader plan's Parts 1–3.

## Fixes (committed)
- `7e59a25` fix(ui): stop supervision-doc flash before the card + restore stopped sessions in sidebar
- `309df5e` test(ui): guard the supervisor no-flash + sidebar stopped-sessions invariants
- `ac7818c` release v0.3.116 · `f6f7d63` release v0.3.117

Files: `web/agents/supervisor.js` (pmLoaded gate in `renderDoc`/`loadTasks`), `web/shell.js`
(`renderSide` live+STOPPED split), `web/desktop.css` (muted stopped pill), `test/ui_render_invariants.test.js`.

## Rendered artifact (inspectable)
`data/design-review/2026-07-12-corrected-session-ui.png` — viewable in the **/aios/review** gallery.
Shows the current build: Supervisor tab renders the **task card** as the primary surface with the
legacy doc collapsed to a *"Legacy doc (retired)"* fold (no doc→card flash), and the sidebar shows
live sessions + a muted **STOPPED** section.

## Visual correction (Issue 1) — no doc flash
`#sup-doc` first-paint sequence recorded with a `MutationObserver` installed before panel JS, on two
neutral card-mode sessions (`s_0e9e27b282`, `s_8ea0dbf260`):
```
LOADING → CARD   (realCard:true — id="pm-new"; errorFallback:false)   [no DOC frame]
```
Before the fix this was `DOC → CARD`. The `pmLoaded` gate makes the first real paint be whichever
surface actually applies. Guarded by `test/ui_render_invariants.test.js` (asserts the not-loaded gate
precedes the doc/card branch, and `loadTasks` flips the flag before its re-render).

## Load behavior (Issue's sibling — Part 2b in-place switch)
Live CDP, clicking session B in the sidebar from session A:
```
full_reloads_during_switch: 0   ·   url pushState A→B: true   ·   switch_ms: 9
header: "Claude Code · Implement the OpenHand…"  →  "Codex · Start a test…"  (content swapped in place)
```

## Part 1 — source-attributed story (complaints #1 empty, #2 mystery messages)
Real `src/story_spine.js#messageToEvent` over `s_8ea0dbf260`'s 102 actual message rows:
| direction\|source | count | verdict |
|---|---|---|
| out\|detect (terminal snapshots) | 69 | dropped |
| in\|agent:supervisor | 12 | dropped |
| in\|text / text+attachments / task (operator) | 21 | kept → "you" |

Live story API: `ok:true, source:fallback, 25 events, 21 operator bubbles, 0 empty/placeholder rows`.

## Part 3 — supervisor amends the card on an operator message (feature #4)
Throwaway session (killed after). Active card "Write hello.txt" → operator composer message rescoping
it → supervisor amended within **8s** to "Write hello world files" / goal "…'hello world' and add a
README.md" (v2→v3). Audit: `[operator] amended — from operator message: Operator explicitly rescopes
the same task…`.

## Deferral (recorded, NOT fixed — out of scope, awaiting operator direction)
Enabling the supervisor via the generic grant API (`POST /api/session/:id/agents/supervisor`) with an
explicit `caps` array that omits `read-context`/`model-calls` yields an enabled-but-broken tick
(logs `not granted capability 'read-context'` every tick). The **panel's own enable flow grants the
right caps**, so this only bites direct API callers. Candidate hardening: `applyGrant` should guarantee
an agent's essential (non-high-risk) caps whenever `enabled` is set, even when an explicit `caps` array
is supplied. Deferred pending operator go-ahead.
