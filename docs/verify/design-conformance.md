# Design conformance review — prototype vs production

**Machine-readable review index** (committed so the evidence lives in git, not only at the `/aios/review`
HTTP gallery). Reference of truth: `Supercalm Desktop.dc.html` (R2 handoff) + the operator's session
screenshots + `docs/MAIN-DESIGN-README.md` ("when the file and README disagree, the file wins"). Live
side-by-side PNGs render at **`/aios/review`** and on disk at `data/design-review/PS-*.png` (gitignored —
binaries; this doc is the readable index of them). Current build: **v0.3.98**.

## Per-surface verdict
| Surface | Verdict | Evidence / what was done |
|---|---|---|
| Inbox (`/`) | ✅ match | Shared app-shell, Voice button, `● proxy` footer, needs-you cards. `PS-Inbox.png`. |
| Session (`/session`) | ✅ match | Hosts the shared shell + first-run banner; story + right Agent panel intact. `PS-Session.png`. Header + collapse fixed (below). |
| Decisions | ✅ match | Doctrine/Messages tabs, rule cards w/ Approve·Edit·Reject + audit chips. `PS-Decisions.png`. |
| Records | ✅ match | 6 filters + 2 dates + search + Export. `PS-Records.png`. |
| Usage | ✅ match | **Rewritten** to the design layout (v0.3.92): "last 30 days" pill, 3 cards, 4 tiles, BY MODEL table, recent-log disclosure. Filter bar / Summary toggle removed. `PS-Usage.png`. |
| Health | ✅ match | **Notice bar** (v0.3.93): graph-stale rendered as the design's yellow callout + working re-index button (was an "Issues" section). `PS-Health.png`. |
| Settings | ✅ match | Vertical left nav (Agents·API·Voice·Remote·Preferences). `PS-Settings.png`. |
| Projects | ✅ shell match | Production-only surface (no design mockup); shell + header conform. `PS-Projects.png`. |

## Fixes applied (with root cause)
1. **App-shell unification (v0.3.8x).** Extracted the sidebar into `web/shell.js` so home + session + all
   injected pages mount ONE shell. Root cause of the session dropping out of the shell.
2. **Palette split (v0.3.91–93).** "Far from the design" was a token split: the shell used the prototype
   palette but injected page content rendered from legacy GitHub-dark `:root` tokens
   (`--bg:#0d1117` / `--panel:#161b22` / `--line:#21262d` / `--ink:#c9d1d9` / `--green:#3fb950`), and
   several pages HARDCODED those hexes in their own `<style>` (decisions 58×, health 14×, auth 22×).
   Aligned `styles.css` `:root` + usage.html local `--u-*` + swept every hardcoded hex to the prototype
   palette (page `#0b0f16`, panels `#161d27`/`#10151d`, border `#232c38`, ink `#e2e8f1`, muted `#8a95a5`,
   green `#4ecb6c`, amber `#e2b23e`). **Legacy-hex sweep now = 0 on all 8 design surfaces.**
3. **Usage layout (v0.3.92)** — matched to the prototype exactly (operator decision "match design exactly").
4. **Header icons (v0.3.95).** Removed the ✏️ rename + ✦ AI-title icon buttons the design lacks; the title
   is already click-to-rename so nothing was lost. DOM-confirmed `titleEditBtn:false`, `titleAiBtn:false`.
5. **Sidebar collapse (v0.3.95).** Restored the `‹ collapse` control the design shows in the brand row
   (removed with the mini-rail in R2). Hides the rail on both the shell grid and the session grid; a fixed
   left-edge `›` tab restores it. Tested clean on decisions + session (no h-scroll, main reflows, restores).
6. **Story panel default font (v0.3.97).** `.story-panel` set no font-family, so it inherited the monospace
   `body` font. Digested cards (.story-body/.story-title/.story-step) override to sans, but any text reaching
   the panel WITHOUT one of those wrappers (undigested/transient/empty/working states) fell back to monospace —
   the operator's "story renders as a terminal dump". Fix: `.story-panel` defaults to 'IBM Plex Sans'; the
   intentional-mono elements (.story-cmd/.story-chip/.story-icon/.story-rollup) set JetBrains Mono explicitly
   and are unaffected. Verified: raw prose in the panel → sans; nested `.story-cmd` → still mono.
7. **Session layout: full-height sidebar (v0.3.98).** The `<header>` + first-run banner were full-width bars
   ABOVE the shell grid, pushing the Supercalm brand down. Design: the left nav owns the full height (nothing
   above the brand) and the header belongs to the content column, not a full-width bar. Moved header + banner
   INTO `.session-shell` and gave the grid header·banner·body rows: sidebar spans all rows (`grid-row:1/-1`,
   full-height column 1), header + banner occupy the content columns (`grid-column:2/-1`), main + agent panel
   in the body row. Geometry-verified: brand at y≈24 with nothing above; header starts at x≈288 (right of the
   280px sidebar); no h/v overflow; collapse still works; right Agent panel untouched.

## Corrected error (recorded honestly)
- I first claimed the story rendered in **monospace**, then "disproved" it by measuring a fully-digested
  session (`.story-body` = proportional IBM Plex Sans) and wrongly reported "no change needed". BOTH were
  incomplete: the digested path IS sans, but the **unwrapped** path (raw/transient text) inherited the panel's
  monospace default — a real bug the operator kept seeing. Root-caused and fixed in v0.3.97 (fix #6 above).
  Lesson: measure the FAILING path, not a passing one; "it matches" and "it's broken" both need verification.

## Verification (the gate — not a single artifact)
- `verify_shell_v3.mjs` **✓** ("shell conforms — supervisor panel, inbox, sidebar, settings, story tripwires")
  on a neutral session (`s_0e9e27b282`).
- `verify_story_view.mjs` **✓** ("story view conforms to spec.tokens.json v2 — DOM, styles, interactions,
  anti-gaming") on the rich fixture (`s_d2d6f4ed08`).
- `npm test` **EXIT=0** (full suite).
- Legacy-hex sweep across `desktop/session/decisions/records/usage/health/settings/projects` = **0**.
- Live: `curl /api/version` → `0.3.98`; `/aios/review` serves 8 per-surface composites + the header/collapse
  before/after (`PS-Header-Collapse-BeforeAfter.png`), all HTTP 200.

## Hard constraint (held)
Right Agent panel (`#session-usage-panel`, `web/agents/*`) — untouched across every change above. The
global palette-token change does not edit its files; it uses its own colors (verified visually intact).

## Not a mismatch (recorded so it isn't re-flagged)
- Numbers are REAL data (Usage totals, session counts, live graphs), not the mockup's placeholders — values
  differ by design.
- Usage quota card reads "loading" until the async subscription call resolves, then shows "N% used" or "—".
