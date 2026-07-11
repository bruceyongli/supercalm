# Design conformance — prototype vs production (master discrepancy list)

Reference: `Supercalm Desktop.dc.html` (R2 handoff, extracted to /tmp/design-ref) + operator screenshots
(design session view) + `docs/MAIN-DESIGN-README.md`. Method: `scripts/design-diff.mjs` captures
production per screen at 1440×900 into /tmp/design-diff/. (Prototype app-screens don't auto-drive
headlessly — its design-tool framework ignores prop/state/nav injection — so the design reference for
app screens is the prototype **source** read per screen + the operator's session screenshots; production
`home` already renders the design shell correctly and is a second on-machine reference.)

## The core pattern
The design is ONE persistent app-shell (`<aside class="dk-side">`: brand · counts · + New session · ⌘K ·
Inbox/Projects nav · SESSIONS list · SYSTEM nav · footer) with every screen rendered in the `.dk-main`
area beside it. Production only mounts that shell on **home**; every other screen is a separate page.

## Per-screen status (production)
| Screen | Has app-shell? | Notes |
|---|---|---|
| home (`/` → desktop.html) | ✅ yes | Matches the design shell (brand, counts, nav, footer). Reference impl. Now renders from the shared `web/shell.js`. |
| **session** (`/session`) | ✅ FIXED | Now hosts the shared app-shell (`web/shell.js` `.dk-side`) + the green first-run banner, matching SS2/SS3. Center + right Agent panel untouched. (Phase 2 done.) |
| projects | ✅ FIXED | `injectShell({activeNav:'projects'})` — content in `.dk-main`, Projects nav active. |
| decisions | ✅ FIXED | `injectShell` + scoped `doctrine-tab.js` legacy toggle to `.dk-main` (it hid `body>*` = the shell). |
| records | ✅ FIXED | `injectShell({activeNav:'records'})`. |
| usage | ✅ FIXED | `injectShell` + desktop.css. |
| health | ✅ FIXED | `injectShell` + desktop.css. |
| settings | ✅ FIXED | `injectShell({activeNav:'settings'})`. |
| onboarding | ≈ close | Welcome matches; standalone by design (pre-shell). Left as-is this pass. |

**Mechanism (Phase 3):** `web/shell.js` `injectShell()` wraps a standalone page — moves its body into
`.dk-main` beside the shared `.dk-side`, adds the ⌘K palette + toast, mounts. One inline module per
page (`import { injectShell } from './shell.js'; injectShell({activeNav})`). Verified headless: all six
render `.dk-shell` grid, 236px sidebar, correct nav active, no errors.

**Minor residual (noted, not blocking):** the three older pages (decisions/usage/health) keep their own
`← Title` header inside `.dk-main` — the `←` back is now redundant with the sidebar. Cosmetic; can be
trimmed in a follow-up.

## Hard constraint
Right Agent panel (`#session-usage-panel`, `web/agents/*`) — **do not touch** this pass. Log any drift
here, do not fix:
- (none logged yet)

## Fix approach
1. Extract the shell (sidebar) from `desktop.js` into a shared `web/shell.js` (+ reuse `desktop.css`).
2. Mount it on `session.html` (replace `#session-rail`), then on each standalone page, so all screens
   live in the shell. Keep each screen's content in `.dk-main`/its main column; keep the session's
   center + right panel byte-identical.
3. Verify each production screen's shell against the home shell + prototype source; screenshot.
