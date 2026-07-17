# Claude 429 quota auto-fallback

## Problem
When the operator's Anthropic account quota (e.g. `claude-fable-5`) is exhausted, every claude session on
a **claude-native** model hits `429 … rate_limit_error … exceed your account's rate limit` and is dead in
the water. Today nothing self-heals it — recovery is manual (2026-07-17 incident: 8 sessions hand-switched
to `gpt-5.6-sol`). Codex already has an equivalent auto-fallback (`pollOnce`, ChatGPT-cap → `codex_via_proxy`);
claude has **none**.

## Insight (why switching the model fixes it)
`authmode.resolveClaudeEnv({model})` probes the model's **fleet-proxy port** and points `ANTHROPIC_BASE_URL`
there. So switching a claude session's model to a **fleet-served id** (`gpt-5.6-sol`) routes its requests off
the Anthropic account → escapes the burned quota. Verified live: claude runs `gpt-5.6-sol`/`gpt-5.5` fine
(tool-use works). Switching to another *claude-native* model (opus/sonnet) does NOT help — same account.

## Design (mirror the codex fallback in `pollOnce`, `src/sessions.js`)
Fire when ALL hold:
- `s.tool === 'claude'`
- `isNativeModel('claude', s.model || TOOLS.claude.model)` — on the Anthropic account (the loop-breaker: after
  fallback the model is `gpt-5.6-sol`, non-native → guard is false → never re-fires)
- `now() - entry.startedAt > LAUNCH_GRACE_MS` — not a fresh-relaunch reprint window (gotcha: `--continue`
  reprints old 429 scrollback)
- `!entry.quotaFallback` (per-entry) and `!fellBackThisTick` (per-tick cap = 1 → staggers a mass burn)
- **`classifyErrorType(detectSessionError(snap.slice(-4000))) === 'rate_limit'`** — REUSE the shared,
  self-echo-hardened classifier (structured error marker required; healthy `⏺`/spinner below ⇒ null;
  negation/"Goal achieved" ⇒ null). No hand-rolled regex.
- **debounce**: `entry.quotaStreak >= 2` consecutive polls of rate_limit (mirrors the `waitStreak` debounce) —
  so a session merely *displaying* 429 text for one frame can never trigger.

Action (once): `store.updateSession(sid,{model: FALLBACK})`, `addEvent('claude-quota-fallback',{from,to,line})`,
log, `bus.emit('changed')`, `await resume(sid,{force:true})` (await → serialize the herd), `continue`.

- `FALLBACK = process.env.AIOS_CLAUDE_QUOTA_FALLBACK_MODEL || 'gpt-5.6-sol'`.
- Misconfig guard: if `isNativeModel('claude', FALLBACK)` (would loop) → skip + warn once.
- Kill-switch: `AIOS_CLAUDE_QUOTA_FALLBACK=0` disables.

## Safety analysis
- **Self-echo (this meta-session on fable-5 is full of 429 text):** classifier needs a structured error line,
  not a topic word; `⏺`/composer below ⇒ null; +2-poll debounce. A conversational session cannot trip it.
  If a talk-about-429 session *genuinely* 429s, falling it back to gpt-5.6-sol IS correct (and `--continue`
  keeps the conversation).
- **Reprint loop:** launch grace skips the reprint window; non-native model after fallback breaks the loop;
  visible-only snapshot means old 429s scroll out.
- **Fleet down / fallback also fails:** the fleet error is not an Anthropic `rate_limit` on a *native* model →
  guard false → one-shot, no loop; `degraded` marker + operator handle it.
- **Herd (mass burn):** per-tick cap 1 + awaited resume → one relaunch per poll interval, self-staggering.
- **No auto-revert:** stays on the fleet model after quota resets (matches codex `codex_via_proxy`); operator
  switches back manually. Acceptable.

## Verification
- Unit (node, import the classifier): (a) real 429 line → `rate_limit`; (b) THIS session's live snapshot →
  not rate_limit (self-echo); (c) 429 with healthy `⏺` below → null; (d) "No 429."/"Goal achieved" → null.
- Live: deploy; confirm the fallback does NOT fire on any session on a fleet model, and does NOT fire on the
  meta-session; watch the log for `claude-quota-fallback` events.

## Adversarial critique (gpt-5.5) — resolutions
- **P0 failed-resume trap** (setting the entry flag then a failing resume leaves it ineligible + still
  dead): ADOPTED. The real loop-breaker is the **persisted non-native model** (guard re-reads `s.model`),
  not the entry boolean. `updateSession(model)` is synchronous and lands before resume, so a resume failure
  can't loop. On resume failure: log + `addEvent('claude-quota-fallback-failed')` + operator `notify`
  (manual Resume) — do NOT revert to native (that would re-fire/loop).
- **P0 re-entrancy / overlap** (`setInterval(pollOnce,1500)` has no overlap guard; a slow tick spawns a
  concurrent pollOnce → double-fire): ADOPTED. Add a `_pollBusy` guard at the scheduler — fixes this AND the
  latent same-bug for the existing codex fallback.
- **Supervisor / degraded interaction**: mitigated by TIMING — the fallback fires at the 2-poll debounce
  (~3s) which is far inside the supervisor's first rate_limit intervention (60s, `ERR_SCHEDULES`); after the
  switch the model is non-native → no 429 → `degraded` clears → supervisor stands down. A cross-subsystem lock
  judged unnecessary (a nudge to a relaunching pane just fails harmlessly).
- **Herd**: per-tick cap = 1 (`fellBackThisTick`) + the overlap guard ⇒ ≤1 relaunch per completed tick,
  self-staggering across a mass burn (matches the manual 8-session recovery cadence). Resume stays
  fire-and-forget (like codex) so pollOnce isn't blocked.
- **Streak reset**: `quotaStreak → 0` on any non-rate_limit poll; the entry (and streak) is recreated fresh
  on resume; scan only runs for claude-native sessions past the launch grace.
