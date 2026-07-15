# Voice module hardening — plan (2026-07-15)

A code review of the voice concierge stack (`src/voice.js`, `web/voicemode.js`, `src/tts.js`,
`src/spark.js`, `src/llm.js`, `src/voice_brief.js`) surfaced 14 issues. This plan groups the ones worth
fixing into five changes, each grounded in the module's architecture rather than point-patched.
External critique (GPT-5.6 + a second model) is appended at the bottom before implementation.

## A. One delivery contract for operator replies
**Fixes: double-send after client abort · failures spoken as successes · stale queue items acted on blind.**

Root cause is architectural: `voice.js` re-implements a *subset* of the canonical `/api/session/:id/input`
route (`sessions.js:2065-2090`) — it skips the tmux liveness check (409 `{stopped:true}` + status sync),
skips the project checkpoint event, and uses a bespoke event name. Two copies of "deliver an operator
reply to an agent" drift.

- Extract `deliverReply(sid, text, { source })` in `sessions.js` = the existing `/input` body
  (tmux `has-session` check → `{ stopped: true }` with status sync; `projectCheckpoint`; `sendText`;
  `addMessage`; `answerPendingDecision`; `input` event + bus emit; `noteReply`). The `/input` route
  becomes a thin wrapper with byte-identical responses.
- `voice.js` send branch calls `deliverReply(..., { source: 'voice' })` and speaks honestly:
  `stopped` → "that session has stopped — I'll leave it; resume it from the dashboard"; a thrown error →
  "I couldn't deliver that — leaving it in the queue". Pointer semantics unchanged (advance; a waiting
  item stays in the store for the next pass).
- Present-time revalidation in `/continue`/`/start`: skip items whose **live** status ≠ `waiting`
  ("that one got handled in the meantime"). At **send**-time, `working` is still deliverable — the
  operator just dictated an instruction, and `/input` allows steering a working agent — only a dead pane
  blocks.
- **Turn integrity**: per-voice-session in-flight flag (`/turn` overlap → 409; the client never
  legitimately overlaps), and a **total brain budget** — `Promise.race([brainReply, 12s])` returning the
  existing "could you say that again?" `await` fallback on timeout. Send side effects only execute in the
  route handler *after* the race, so a late brain result is discarded, never delivered. Server worst case
  (~12s) then sits far inside the client's 30s `/turn` abort, closing the "client died, server still
  sends" window.

## B. `llm.js`: one chain dispatcher
**Fixes: `chatJson` can't route `api:` entries (port `undefined` → dead request) and never gets the
user-provider tail that `chat()` has.**

Extract a `callEntry(entry, messages, opts)` (fleet port → `once()`; `api` → `routeForModel` +
`callProxyModel`) used by both `chat()` and `chatJson()`; `chatJson` keeps its junk-JSON fall-through and
gains `withUserTail()`. Add `opts.timeout_ms` to `once()` (default 45000, unchanged for existing callers);
the voice brain passes ~10s per model. Side effect (intended): the other `chatJson` consumers
(`deploy_reviewers.js`, `sessions.js` summarizer) gain the no-fleet user-provider fallback, consistent
with the tail's stated purpose.

## C. Client capture hardening (`web/voicemode.js`)
**Fixes: mic-permission denial = infinite spoken nag loop · iOS suspended AudioContext truncates every
reply at 8s · VAD tick frozen in background tabs · `ui` null-deref after Stop.**

- `getUserMedia` rejection propagates typed (`NotAllowedError`/`NotFoundError`): overlay "Microphone
  blocked — allow mic access and tap Voice again", graceful end. Server belt: 3 consecutive empty turns →
  `done: true` with a spoken sign-off (covers any other silent-capture mode).
- After creating the per-turn `AudioContext`, `await ac.resume()`; if state still isn't `running`
  (iOS, out-of-gesture), enter VAD-dead mode: grace window 8s → 15s so replies aren't cut mid-sentence.
- VAD tick moves `requestAnimationFrame` → `setTimeout(tick, 100)` (background tabs keep ticking).
- `ui?.heard` guard on the post-transcribe update (Stop mid-transcription currently throws).

## D. TTS/STT config + fallback consistency
- `/api/tts/stream` and `/api/tts/health` resolve `voiceConfig()` / `effectiveSpark()` / `sparkEnabled()`
  exactly like `/api/tts` — today Settings → Voice overrides (engine/voice/IP/disable) apply to short
  lines but not streamed ones. A muted/non-spark backend → 409 (client already falls back to `/api/tts`).
- `spark.js /api/transcribe`: a *thrown* Spark attempt (unreachable host, missing ffmpeg) falls through to
  the configured speech provider the same way an HTTP ≥400 already does (today it 502s past a healthy
  provider).
- Spark single-shot TTS timeout 60s → 25s so the `say` fallback still lands inside the client's 60s abort.

## E. Small cleanups
- `speakStream` zero-chunk failure falls back to `speakParts(splitSentences(text))` (pipelined
  per-sentence synthesis — the latency design) instead of single-shotting the whole text; revives the
  currently-dead `speakParts`.
- `voiceSessions` stale sweep on a 5-minute interval (today it only runs when someone starts a new pass).

## Explicitly out of scope (operator UX calls)
- Rolling newly-waiting sessions into a live pass (today: counted at the end, "tap Voice again").
- Barge-in (speaking over TTS to interrupt).

## Verification
- `npm test` (already the integrate gate) — plus new units where seams exist: `llm.js` dispatch with an
  injectable transport (pattern: `deploy_reviewers`' `chatJsonFn`), `/input` ↔ `deliverReply` equivalence.
- Isolated instance (`AIOS_PORT`/`AIOS_DATA` scratch): drive `/api/voice/start` (empty queue), `/input`
  on a live scratch session, `/api/tts/stream` 409 when spark is muted.
- Client paths with a synthetic `getUserMedia` (oscillator → MediaStreamDestination), as used for the
  launch-modal dictation verification.

## External critique (pre-implementation) — GPT-5.6-sol + kimi-k2.6, 2026-07-15

Both models reviewed the plan against the line-numbered current code (gemini-pro-agent was tried first
and is 403/ToS-disabled upstream). Full raw outputs were reviewed by the implementing session; the
adopted resolutions below amend the sections above.

**Adopted — plan amended:**
- **A / atomicity**: post-send bookkeeping (`addMessage`, `answerPendingDecision`, events, `noteReply`)
  becomes best-effort (individually caught) — once tmux accepted the text, nothing may re-announce the
  reply as failed, or the next pass double-delivers. Only `sendText`/liveness failures count as failures.
- **A / delivery seam**: `deliverReply` takes already-normalized `{ text, source }`; HTTP parsing,
  attachment normalization, and status-code mapping stay in the `/input` route (no "byte-identical
  extraction" claim — the route owns its envelope).
- **A / abort window**: the 12s brain budget alone doesn't close it — also check the request's
  socket state (`req.destroyed`) immediately before delivery, and hold ONE in-flight lock per voice
  session that `/turn` AND `/continue` both respect (409 on overlap), released in `finally`, acquired
  after body parse. `/stop` clears it.
- **A / send rule refined**: deliver when live status is still `waiting`, or `working` with **no
  operator input since the item was presented** (someone else answering = stale; the agent merely
  resuming = still steerable). Distinct speech for "stopped" (status synced to exited — it will NOT
  reappear; say so) vs "already handled — moving on".
- **A / revalidation**: skip stale items in a loop (not one step), and re-check once more after the
  4s brief wait in `present()`.
- **B**: `withUserTail` applies to `chatJson` under the same rule as `chat()` (default chain only),
  **deduplicated** against models already in the chain; `once()` gains an abort signal (socket
  `timeout` is inactivity, not a total deadline — the outer race stays the true bound, the signal stops
  paying for orphaned attempts); `maxTokens`/`max_tokens` translation handled centrally in the
  dispatcher; keep the api-vs-port distinction in failure logs.
- **C / root fix for iOS VAD**: reuse ONE `AudioContext` created (and resumed) inside the Voice tap
  gesture (`unlockAudio`) for all turns' analysers — a suspended per-turn context was the root cause;
  `resume()` + the longer VAD-dead window remain as belts. Mic *stream* stays per-turn (indicator off
  while the assistant speaks).
- **C**: install `rec.onstop` before calling `rec.stop()`; wrap the whole capture in `finally` cleanup
  (tracks/recorder/analyser) so constructor failures can't leak the mic; typed `getUserMedia` errors
  propagate past the generic catch; empty-turn counter lives server-side on the voice session, resets
  on non-empty input, and the sign-off also renders in the overlay (audio may be the broken part).
- **D**: request fields keep overriding settings, but a UI-muted Spark cannot be re-enabled via
  `b.backend` (same rule `/api/tts` has today); in `/api/tts/stream`, only destroy the upstream on
  client close when the response hasn't already finished; STT gets separate try scopes for
  direct-Spark / transcode / provider, and the provider fallback receives the ORIGINAL audio when
  ffmpeg is missing; TTS per-stage timeouts sized so the worst-case chain fits the client's 60s abort
  (spark 25s, provider 25s, local 20s).
- **E**: no sweep timer — lazy expiry keyed on **last-touch** (not `createdAt`; the current 30-min
  `createdAt` sweep can kill a LIVE long pass), checked on every voice endpoint; delete the
  empty-queue session eagerly at `/start`.

**Rejected — with reasons:**
- Persistent delivery-ID/idempotency records for voice sends (GPT-5.6): the in-flight lock + socket
  check + budget shrink the window to non-practical; a durable dedup store is disproportionate for a
  human-confirmed conversational loop. Revisit if a double-send is ever observed post-fix.
- One persistent mic stream for the whole voice session (both models): deliberate trade — the mic
  indicator staying hot while the assistant speaks is worse UX/privacy, and echo pickup risk grows;
  per-turn acquisition stays.
- Tap-to-finish recording affordance in VAD-dead mode (GPT-5.6): house UI principle — no new visible
  controls for rare edge cases; the bounded window + live recognizer preview cover it.

**Process note**: the first integration attempt of unrelated work exposed that the deterministic gate
was rejecting ALL integrations (`store.js` worktree DB guard false-positived on the test suite's
tmpdir `AIOS_DATA` when run from the gate's linked worktree). Fixed as its own change:
`src/db_guard.js` (refuse only the canonical data dir, derived from the worktree's `.git` pointer) +
`test/db_guard.test.js` covering the class.
