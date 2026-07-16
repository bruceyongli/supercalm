# Subscription STT — dictation from the user's CLI auth (2026-07-16)

## Why
Local Whisper/Spark STT is real setup + disk. But almost every Supercalm user has already
authenticated a coding CLI (Codex or Claude), and **both ship a private transcription endpoint usable
with that same login**. So: the moment a user authes their CLI, they should get voice-to-prompt with
**zero extra setup**. TTS stays a separate, optional step (local Kokoro or a cloud provider — unchanged
by this work). STT source is always overridable (a user who prefers local Whisper keeps it).

Operator decision (2026-07-16): make subscription STT the default when a CLI is authed; **match the
session's agent** (Codex session → Codex STT, Claude session → Claude STT); agent-less surfaces use
Codex for its low-latency one-shot path. Ship **Codex first (drop-in), Claude WebSocket as the
immediate fast-follow**; Spark remains the fallback so nothing regresses in the meantime.

## Endpoints (private, reverse-engineered — treat as unstable)
Both are **STT only**. Neither provides TTS. Source: an operator-provided integration note (SiriPlus).
- **Codex** — `POST https://chatgpt.com/backend-api/transcribe`, `Authorization: Bearer <access_token>`,
  `ChatGPT-Account-Id: <account_id>`, `originator: Codex Desktop`, multipart `file=` a **16 kHz mono
  s16 PCM WAV** → `{"text": "..."}`. One-shot. Egress to chatgpt.com confirmed reachable from host.
- **Claude** — `wss://claude.ai/api/ws/speech_to_text/voice_stream` (Deepgram Nova 3), raw linear16 PCM
  frames + `KeepAlive`/`CloseStream`, events `TranscriptText`/`TranscriptEndpoint`. Streaming. **Pass 2.**

These are unofficial and can break without notice; every failure path must fall back, never hard-fail.

## What already exists (the cheap part)
- **Auth**: `~/.codex/auth.json` on-disk shape verified:
  `{ last_refresh, tokens: { access_token, account_id, id_token, refresh_token } }` — exactly the
  bearer + account-id the endpoint needs. **NB (critique):** do NOT reuse `getAccessToken('codex')` — it
  reads a cached cred and codex is `refreshable:false`, so it can hand back a stale/expired token and
  never refresh. The Codex CLI owns refresh; we **read the file fresh per attempt** (see §3).
  (`getAccessToken('claude')` self-refreshes and is fine for the pass-2 Claude path — pending the
  token-source probe.)
- **Transcode**: `spark.js toWav()` already emits `-ac 1 -ar 16000 -f wav` — the exact WAV Codex wants.
- **Route**: `POST /api/transcribe` already has a **source-fallback** structure (Spark → OpenAI-compatible
  provider). Subscription STT slots in as another source. The browser calls this one endpoint from 4
  places (session composer, new-session box, voice concierge, phone) — so default selection is a
  **server-side** decision; the client only needs to pass an optional *which-agent* hint.

## Architecture

### 1. STT source model — an ordered CANDIDATE LIST, not a single enum
**Critique fix (both models):** preference and egress policy are separate concerns, and "match the
agent" must never mean "send Claude audio to OpenAI because Codex is authed." So the route acts on an
**ordered candidate list**, and the ONLY automatic cloud→cloud / cross-vendor hop is Spark-or-provider,
never one subscription vendor falling to another.

Stored preference `stt_source ∈ auto | codex | claude | spark | provider` (default **auto**). The list is
built from the preference + an optional per-request `agent` hint:

| preference | agent hint | candidate list (tried in order, each falls to the next ONLY on eligible failure) |
|---|---|---|
| `auto` | `codex` | `[codex, spark, provider]` |
| `auto` | `claude` | `[claude, spark, provider]` — pass 1: claude unbuilt ⇒ effectively `[spark, provider]` |
| `auto` | none | `[codex, spark, provider]` (codex = low-latency one-shot; never claude-without-hint) |
| `codex` | any | `[codex, spark, provider]` |
| `claude` | any | `[claude, spark, provider]` |
| `spark` | any | `[spark]` — a user who picks LOCAL stays local; never silently crosses to cloud |
| `provider` | any | `[provider]` (this IS a cloud choice the user configured) |

Rules: (a) a subscription source **never** falls through to the *other* subscription vendor — only to
Spark/provider; (b) pinning `spark` means `[spark]` only (no cloud surprise — the privacy point);
(c) unbuilt sources (claude in pass 1) are skipped, not errored; (d) empty list / all-failed → the
existing 502 "no STT configured / all failed". Every hop logged server-side (status + lengths only,
never transcript); response reports the `backend` that answered (existing field).

### 2. Where it plugs in (`src/spark.js` `/api/transcribe`) — refactor to a candidate loop
**Critique fix (gpt #2):** do NOT splice a prepend into the current nested flow — it would force ffmpeg
before Spark (which accepts webm directly), double-transcode, and stack timeouts. Refactor the route
body into an explicit loop over the resolved candidate list, with:
- **one request-scoped deadline + AbortController**, cancelled on client disconnect (`req` close/abort),
  so the server stops working the moment the browser gives up (today it keeps uploading + falling back);
- a **lazy, memoized `getWav()`** — transcode once, only when a candidate needs it (Codex needs WAV;
  Spark tries the original container first, then WAV; provider gets the original). No repeat ffmpeg.
- each candidate = `{ name, run(audio, getWav, signal, {language, deadline}) }`; a candidate's failure is
  classified (see §Failure policy) into fall-through vs stop.
Preserve exactly: `?backend=provider` **still forces `[provider]`** (ops/test flag — subscription must
NOT override it); Spark's direct-then-transcode retry; provider-gets-original-audio; the 40 MiB body cap;
bounded upstream response reads (no unbounded `arrayBuffer` on the Codex/provider responses).

### Failure policy (critique #4, both models) — which errors fall through
- missing/expired/malformed `auth.json`, DNS/connect failure, 5xx before upload → **fall through** (clean).
- `401/403` → re-read auth once; retry only if the **token changed**; else fall through. Persistent codex
  auth failure updates the STT-source status (Settings surfaces "re-auth Codex") — NOT a per-transcribe
  `hint` field (the client discards all fields but `text`/`language`; an unwired hint is dead protocol,
  and it must never show when a fallback then succeeded).
- `429` → do **not** hammer the rest of the chain; respect a bounded `Retry-After` or fall through **once**
  with a backoff note; never burn Spark+provider quota on every rate-limit.
- **timeout after the audio was uploaded** = ambiguous (Codex may have processed it). Fall through so the
  user still gets a transcript, but this is the one path that can double-egress the user's own audio to
  their own Spark; documented, bounded, not silently multiplied further.
- malformed 200 / empty `text` → treat as failure, fall through.

### 3. Codex transcriber (`src/stt_codex.js`, new)
- `codexDictationAuth()` — **read `~/.codex/auth.json` fresh each attempt** and parse it into ONE
  snapshot; derive bearer + account from that SAME object (critique #3: never split-read token A with
  account B during a CLI rotation). Bearer = `tokens.access_token`. Account id = **`tokens.account_id`
  first** (verified present, what AIOS/CLI writes), JWT `chatgpt_account_id`/`account_id` claim only as
  fallback (`decodeJwt` is unverified — we merely forward the id, never trust it for authz, and prefer
  the non-JWT field). Check `exp` with clock skew before egress. Return a typed error distinguishing:
  missing file · malformed/partial JSON · expired · permission-denied · absent account_id. Never cache,
  copy, or log the token; not in argv/env.
- `transcribeCodex(wavBuffer, { signal, timeoutMs })` — multipart `file=audio.wav` (audio/wav) → POST with
  the headers (`Authorization`, `ChatGPT-Account-Id`, `originator: Codex Desktop`, UA). Bounded upstream
  read. Parse `{text}` → trim; empty/malformed → error. Classify 401/403/429/5xx/timeout per the failure
  policy above. Log status + byte/char lengths only — never audio/transcript/token.
- **`originator: Codex Desktop` is app-mimicry** (critique #3, ethics flag): it's inherent to using a
  private *app* endpoint, and the endpoint likely requires it. The operator has accepted the
  unofficial-endpoint risk; this is called out here as a conscious choice, not hidden.

### 4. Agent hint (client → server), minimal
**Critique fix (gpt #5, kimi #4):** just `?agent=codex|claude` — drop `?for=<sessionId>` (a DB round-trip
+ an access-control surface; the caller already knows the agent). Server clamps the value to the known
set; unknown/absent → no hint. Wiring:
- Session composer (`common.js wireMic`, session page): pass `agent=<the session's tool>`.
- New-session dictation (`shell.js`/`app.js`): pass `agent=<selected tool>`.
- Voice concierge (`voicemode.js`): pass the current item's agent when present.
- Phone: default (no hint) for pass 1.
`wireMic` gains an optional `hint` arg (string or `() => string`); existing callers unchanged. `agy`
sessions have no subscription STT → `[spark, provider]`. Claude hints in pass 1 (unbuilt) → `[spark,
provider]`, so a claude session keeps its **current** behavior — no regression, and crucially no
cross-send to OpenAI.

### 5. Config + UI
- Store `stt_source` (+ later per-agent detail) in the voice override (`data/model_providers.json`), read
  at request time (hot-reload, like the rest of voice config). Env kill-switch `AIOS_STT_SUBSCRIPTION=0`
  (house style: an emergency global off). Surface built/available sources in `/api/tts`… no — in a small
  `GET /api/stt/sources` (or fold into the existing voice-config payload) so the UI can show what's live.
- **Settings → Voice**: an "Speech-to-text" picker — Auto (recommended) / Codex / Claude (shows "sign in
  to Codex/Claude" when not authed or "coming soon" for Claude in pass 1) / Local Whisper (Spark) / Cloud
  provider. Mirrors the existing TTS controls; no new brain-load on the coding UI (per house UI principle,
  this lives in Settings, not the composer).

### 6. Claude path (pass 2, sketched, NOT built now)
`src/stt_claude.js`: a server-side WS proxy to `wss://claude.ai/api/ws/speech_to_text/voice_stream`
(reuse the `/api/tts/stream` proxy shape, but bidirectional binary). **Open question the spec must
resolve before building**: does AIOS's own Claude login (`~/.claude-proxy/oauth_creds.json`, minted by
`src/auth` PKCE) present a token that `claude.ai/api/ws/...` accepts, or does it require the **Claude
Code keychain** item (`security find-generic-password -s "Claude Code-credentials" -w`, client_id
`9d1c250a-…`)? Probe both before committing. Two client modes: (a) batch — stream the recorded blob's
PCM, `CloseStream`, take the final text (drop-in for today's flow); (b) live — server-side interim
transcripts replace the browser's `SpeechRecognition` preview (a UX upgrade, later).

## Security & correctness invariants
- Tokens: read per call, never cached/persisted/copied/logged; not in argv/env. 401/403 → reload once,
  then surface a one-time re-auth hint; never spin.
- Audio + transcripts are the user's — sent only to the user's own subscription endpoint; never logged
  beyond byte/char length. This is an **external egress** of user audio to chatgpt.com/claude.ai; it
  happens only when a subscription source is selected (default when authed, per operator decision).
- Fail-open everywhere: any subscription failure falls through to Spark/provider; voice never dies from
  one outage. Timeouts sized inside the client abort budgets.
- No change to TTS or the concierge brain.

## Verification
- Unit: the pure `resolveSttSource(pref, hint, {codexAuthed, claudeAuthed, sparkOn, providerOn, claudeBuilt})`
  table; `codexDictationAuth()` parsing (fixture auth.json, redacted); route fallback with an injected
  failing codex transcriber → Spark answers.
- Isolated instance: `/api/transcribe?agent=codex` with a real recorded WAV → `{text, backend:'codex'}`;
  force `codex_reauth` (bad token fixture) → falls back to Spark + `hint:'reauth-codex'`; `stt_source=spark`
  pins Spark.
- Live (operator, opt-in): flip Settings → STT to Codex, dictate in a session, confirm the transcript +
  that it matched the session agent.
- Full `npm test`; ship through the autonomous pipeline.

## Out of scope
- TTS of any kind (unchanged).
- Claude WS (pass 2).
- Live server-side interim streaming (pass 2b).

## External critique (pre-implementation) — gpt-5.6-sol + kimi-k2.6, 2026-07-16
Both reviewed the spec against the line-numbered current code. Full raw outputs: `/tmp/stt-critique-*.md`
(reviewed by the implementing session). The body above was amended inline; net resolutions:

**Adopted — reshaped the design:**
- **Preference ≠ egress policy** (both, the biggest one): §1 is now an ordered per-agent candidate list.
  A subscription vendor NEVER falls to the other vendor; pinning `spark` (local) stays `[spark]` and never
  crosses to cloud. Kills "Claude audio → OpenAI because Codex is authed" and "I chose local but it went
  to a cloud provider."
- **Honest pass-1 scope**: "match the session's agent" is only fully true once Claude ships. Pass 1 =
  Codex sessions → Codex STT; **Claude sessions stay on Spark** (unchanged behavior, no surprise egress).
  Claude WS is a separate streaming+auth project, not a drop-in.
- **Codex auth**: read `~/.codex/auth.json` fresh per attempt (NOT the caching `getAccessToken`; codex is
  `refreshable:false`), one snapshot for token+account, expiry+skew check, typed error taxonomy, 401 →
  re-read-once-retry-if-changed-else-fallback. `tokens.account_id` preferred over the unverified JWT claim.
- **Route = candidate loop** with a request-scoped deadline + client-abort cancel + memoized `getWav()`;
  preserve `?backend=provider` force, Spark direct-then-transcode, provider-gets-original, bounded upstream
  reads.
- **Failure taxonomy** (429 backoff, ambiguous post-upload timeout, empty-200) instead of blanket
  "≥400 → fall through".
- **Drop the unwired `hint:'reauth-codex'`** per-response field; surface persistent codex auth failure via
  the STT-source status / Settings instead. Never signal reauth when a fallback succeeded.
- **`?agent=` only** (drop `?for=<sessionId>`).
- **Settings copy states the destination + that the endpoint is unofficial**; new Codex-path logging is
  status+lengths only.
- Modest **global in-flight cap** on subscription calls + bounded upstream read (cheap subset of gpt #6).

**Rejected / deferred — with reasons:**
- **Mandatory per-recording opt-in / first-use consent gate** (kimi #3, gpt #5): the operator explicitly
  chose subscription-STT default-ON when a CLI is authed (2026-07-16). Kept default-on, mitigated by
  explicit Settings copy + never-local→cloud + the strict candidate lists. This is a deliberate divergence
  from the critics on the operator's authority; revisit if Supercalm ships beyond the single operator.
- **JWT signature verification** (kimi #3): unnecessary — we forward the id, don't trust it for authz, and
  now prefer the non-JWT `tokens.account_id`. Guard against malformed/oversized tokens only.
- **Full media-duration probing, per-client concurrency, ffmpeg-kill orchestration** (gpt #6): over-built
  for a single-user tailnet service in pass 1. Body cap (exists) + upstream-read cap + one global in-flight
  cap suffice; the rest noted as follow-ups.
- **Truthful/alternate `originator` header**: the endpoint is the desktop app's; presenting as it is
  inherent to the feature the operator authorized. Documented as a conscious risk, not silently forged.

**Net effect on scope:** pass 1 is honestly *Codex STT auto-selection + Codex-session matching + a
candidate-loop refactor of `/api/transcribe` + Settings picker*, Spark unchanged as default/fallback and
still serving every Claude/agy session. Claude WS (auth-source probe + streaming proxy) is pass 2.
