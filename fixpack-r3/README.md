# Fixpack r3 — I wrote the fixes; you run one command

Round-2 fixes from Claude Code actually landed (title rows, tints, anti-gaming, rail behavior,
desktop tokens). What was still broken was **deeper: the parser's assumed Codex log shapes didn't
match your real rollout files** — I re-read the actual JSONL in `data/` line by line and rewrote
the parser against reality. No instructions this time; this folder contains the final code.

## Apply (from the repo root)

```bash
node fixpack-r3/apply_fixes_r3.mjs          # dry-run: verifies anchors, writes nothing
node fixpack-r3/apply_fixes_r3.mjs --apply  # applies with .r3bak backups
```

All-or-nothing: if any anchor doesn't match your working tree, nothing is written and it tells
you which one. Revert = restore the printed `.r3bak` files.

## What was actually wrong (found by reading `data/*.jsonl` raw)

1. **Codex stories had no "You said" events — and answered questions kept coming back.**
   Real rollouts log user turns as `response_item {type:"message", role:"user"}`, which the parser
   ignored. The answered-detection (S7) looks for a later `you` event — with none, every ask stayed
   "unanswered" and its buttons resurrected on each refresh. This is the "broken again and again".
2. **User turns are wrapped in injected context** (`<project_context>`, `<relevant_lessons>`,
   TUI scrollback echo). Naively rendering them = giant noise walls. The parser now strips the
   blocks and keeps the last human-written paragraph.
3. **Benign exit-1s rendered as red FAIL cards.** `rg`/`grep`/`find`/`diff` exit 1 = "no match",
   not an error. Non-technical users saw a story full of scary ✗. Now suppressed (call-id → command
   map); real failures (exit ≥ 2, or exit 1 from other commands) still show.
4. **Exit codes weren't detected at all** for outputs shaped as JSON (`{metadata:{exit_code}}`) —
   the old regex only matched prose. Both shapes parse now.
5. **Codex asks (`request_user_input` tool calls) never became ask cards.** Mapped now, with options.
6. **Claude user messages with array content were dropped** (same S7 consequence on Claude sessions).
7. Gaps now say `quiet for 25 min — parked until you answer` instead of a bare rule; model/effort
   surfaces once as a `sys` line; stale ✓/recovered states re-render (signature-based refresh, not
   count-based).
8. Two token drifts: desktop page `h1` 26→19px; base `.story-ts` 9.5→10px.

## Verify after applying

```bash
# parser smoke against your real logs (also printed by the applier):
#   expect: >0 events, you>0 for BOTH files, asks answered == total asks (this data), small fail count
node --input-type=module -e "import('./src/story.js').then(async m=>{const fs=await import('node:fs');for(const f of fs.readdirSync('data').filter(x=>x.endsWith('.jsonl'))){const ev=m.parseSessionLog(fs.readFileSync('data/'+f,'utf8'));console.log(f, ev.length+' events', 'you='+ev.filter(e=>e.kind==='you').length, 'fail='+ev.filter(e=>e.kind==='fail').length, 'asks answered='+ev.filter(e=>e.kind==='ask'&&e.answered).length+'/'+ev.filter(e=>e.kind==='ask').length)}})"

# full conformance (unchanged):
node verify_story_view.mjs http://127.0.0.1:8789/session?id=<live-session>
```

## Files
- `src/story.js` — full parser replacement (header lists F1–F9 with the evidence)
- `apply_fixes_r3.mjs` — the applier (dry-run by default)

Note: `local_grep`-style searches silently miss these logs' multi-KB lines — that's why earlier
audits (mine included) validated the wrong shapes. The r3 parser was checked against raw line reads.
