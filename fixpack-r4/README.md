# Fixpack r4 — data-reality fixes + whole-shell verification gate

Diagnosis from the 2026-07-11 screenshots: the story TIMELINE is now correct (r3 landed), but
three issue classes remained. This pack fixes class A in code, adds machine checks for class B,
and specs the class C data fix with acceptance tests.

- **A · design vs real data (fixed here, in code):** `199.2 hr active · 97 unresolved fails`
  rollups, raw-markdown report walls, fail cards titled "fail" with visible `<tool_use_error>`
  tags, "Ran: Read" steps, "1 step · ▸ 1 step" duplication.
- **B · conformance drift on unguarded surfaces (now machine-checked):** old supervisor
  segmented + THE CONTRACT chip back, Settings' contradictory duplicate CLI rows, always-open
  inbox replies, sidebar chip/status collision, URL-as-session-name, missing mini-rail dots.
- **C · inbox fed raw terminal tail (agent task below):** cards must show the derived question,
  not TUI scrollback.

## Step 1 — operator (or agent) applies the code fixes

```bash
node fixpack-r4/apply_fixes_r4.mjs          # dry-run
node fixpack-r4/apply_fixes_r4.mjs --apply  # .r4bak backups
```

## Step 2 — the once-and-for-all gate

Add to `package.json` scripts (agent does this in the prompt below):

```json
"verify:design": "node verify_story_view.mjs $SESSION_URL && node fixpack-r4/verify_shell_v3.mjs $BASE_URL $SESSION_URL $SETTINGS_URL"
```

and a pre-push hook (or CI job) that runs it against a dev server. Design drift becomes a
failing build, not a screenshot argument.

## Step 3 — supervisor doctrine rules (paste into Decisions → propose, then approve)

1. WHEN A SESSION CLAIMS UI/DESIGN WORK IS DONE → require `npm run verify:design` output with
   exit 0 in the same message; block "done" otherwise.
2. WHEN A DIFF TOUCHES verify_story_view.mjs, verify_shell_v3.mjs, spec.tokens.json, or any
   fixpack file → reject and ask the operator; these files are operator-owned.

## Step 4 — prompt for Claude Code

```
Fixpack r4 is in the repo root. Steps, in order; paste each command's output as evidence.

1. node fixpack-r4/apply_fixes_r4.mjs — if any anchor fails, STOP and report the output verbatim.
2. node fixpack-r4/apply_fixes_r4.mjs --apply
3. Parser smoke (same as r3 README): both data/*.jsonl parse, you>0 each, no <tool_use_error>
   or "| Item |" markdown artifacts in any event body (grep the JSON output).
4. Fix the class-B findings until verify_shell_v3 exits 0. Exact targets:
   a. Session right panel: replace the Off/Observe/Co-pilot/Autopilot segmented with ONE row:
      `co-pilot ▾` native select (transparent bg, no border, mono 12px 700, color #79b8ff,
      ▾ affordance) · `model gpt-5.5 · chain ▸` · green dot `on server` · `Run check` ghost
      button (28px, border #232c38). One-line mode description under the row, 12px #8a95a5.
      Remove the SUPERVISOR heading and the THE CONTRACT chip.
   b. Settings → Agents: merge login-state and install-state into ONE card per CLI:
      name · version or (not found + Install/Update button) · LOGGED IN/SIGNED OUT chip ·
      token expiry · Re-login disclosure. No CLI name may appear in two rows.
      Remove "No API providers yet." whenever provider rows render.
   c. Inbox cards: `.dk-reply` starts hidden; clicking Reply reveals it (existing wireCards
      handler) — remove whatever forces it open on render.
   d. Sidebar session rows: name = session/project short name (never a URL — if title is a URL,
      use the project name); ensure flex gap so agent chip and status word cannot overlap
      (`.dk-sess-l1 { gap: 6px; } .dk-agent { flex-shrink: 0; }` + min-width on the name).
   e. Collapsed mini-rail must render one dot per live session on collapse (call renderMiniDots()
      inside setRailMini after the class toggles).
5. Class C (server): the triage payload's `question` field must be the last unanswered `ask`
   event from src/story.js for that session; fall back to the last `report` (≤300 chars,
   de-markdowned). Cards must never contain "bypass permissions on", "context used", or
   "shift+tab to cycle". verify_shell_v3 asserts this.
6. Run: node verify_story_view.mjs <session-url> AND
        node fixpack-r4/verify_shell_v3.mjs <base-url> <session-url> <settings-url>
   Fix ONLY named findings until both exit 0.
7. Add the "verify:design" npm script (README Step 2) and a pre-push hook that runs it.

Hard rules: never edit verifiers/spec/fixpacks; never restyle beyond named findings; done =
steps 3+6 outputs pasted with exit 0.
```

## Files
- `src/story.js` — r4 parser (F10–F13 on top of r3's F1–F9)
- `apply_fixes_r4.mjs` — deterministic applier (dry-run default)
- `verify_shell_v3.mjs` — whole-shell probe (supervisor panel, settings, inbox, sidebar, rail,
  parser-regression tripwires)
