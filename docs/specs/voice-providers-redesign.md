# Voice config redesign — provider-centric TTS/STT (2026-07-16)

## Why
Voice config grew organically and is now incoherent (operator, with a screenshot). Symptoms:
- A "voice choice" of 3 cards (Local=Whisper+Kokoro / GPT=OpenAI / Browser) that each **bundle** a
  TTS+STT pairing, PLUS a separately bolted-on "Dictation source" dropdown for STT — so **STT is chosen
  in two places that can conflict**, and STT-only subscription sources (Codex/Claude) don't fit the card
  model.
- Choosing a card **mutates Spark** via `sparkDisabled`, conflating "which TTS provider" with "is Spark on".
- Claude STT shows "coming soon" (never delivered).
- Under the hood: 3 separate client TTS stacks, 2 settings UIs, 2 TTS authorities that can disagree.

Root cause: providers have **asymmetric capabilities** (some TTS-only, some STT-only, some both), but the
UI models "a voice" as one bundled thing. Fix: model every source as a **provider with capabilities**, and
let **TTS and STT be selected independently**, each with a fallback chain.

Design pressure-tested by gpt-5.6-sol + kimi-k2.6 (raw: `/tmp/voice-arch-*.md`); their consensus is folded in.

## Claude STT — honest verdict (NOT "coming soon")
Probed `wss://claude.ai/api/ws/speech_to_text/voice_stream` from headless Node (raw TLS WS upgrade, valid
Bearer + `x-app:cli`): **HTTP 403 `cf-mitigated: challenge`** — Cloudflare's bot/JS challenge blocks at the
edge before the token is evaluated; same with a browser UA. A client-side WS from our origin can't carry
claude.ai's `cf_clearance`/session cookies (cross-origin isolation). Every bypass (TLS-fingerprint
impersonation, headless-browser cookie harvesting, cf_clearance scraping) is fragile and unfit for
production, and violates the no-new-deps rule. **Both reviewers: hard no.** So Claude is modeled as an
STT-capable provider that is **`unavailable`** with detail "browser-gated — no supported headless API",
NOT a selectable "coming soon". (Auth itself is fine — same client_id `9d1c250a…` + `claudeAiOauth`
envelope as Claude Code — so if Anthropic ever ships a real STT API this flips on by config alone.)
Codex STT stays, labeled **unofficial/private** (uses the user's own ChatGPT token; may break if the
endpoint changes).

## Model

### Providers (registry, `src/voice_providers.js`)
Each source is a provider with capabilities + metadata (reviewers: `{tts,stt}` alone is too thin):
```
{ id, label, caps:{tts,stt}, location:'tailnet'|'server'|'cloud'|'browser',
  configured:bool, available:bool, status:'ok'|'needs-signin'|'not-configured'|'unavailable',
  detail:string }
```
| id | caps | location | available when |
|----|------|----------|----------------|
| `spark` | tts+stt | tailnet | SPARK ip set AND not muted |
| `codex` | stt | cloud (user's ChatGPT) | `~/.codex/auth.json` valid (else status `needs-signin`) |
| `claude`| stt | cloud | **never** (status `unavailable`, browser-gated) |
| `cloud` | tts+stt | cloud | speech provider has `base_url` |
| `macos` | tts | server | local `say` service reachable |
| `browser`| tts+stt | browser | always (client-side only; **emergency fallback**, not a peer) |

`location` drives the **privacy rule** below. `browser` is client-only: the server can't invoke it; it's a
terminal fallback the client handles (`speechSynthesis` / live `webkitSpeechRecognition`).

### Config v2 (per-capability selection, `model_providers.json` → `.voice`)
Replaces the `sparkDisabled` + `sttSource` + card-implied tangle:
```
voice: { version:2,
  tts: { primary:'spark',       fallbacks:['macos','browser'] },
  stt: { primary:'match-agent', fallbacks:['spark','browser'] } }
```
Provider *config* (Spark host/voice, cloud base_url/key) stays where it is (`.voice.spark`, `.speech`) —
config is separate from routing. `match-agent` is a **policy**, not a provider: at request time it resolves
to the session's agent's STT provider (codex; claude→skipped since unavailable), then the ordinary chain
continues.

### Resolver (generalize `src/stt_source.js`)
`resolveChain({capability, primary, fallbacks, avail, agentHint})` → ordered available provider ids.
Rules (from critique):
1. `match-agent` (STT only) expands to the hinted agent's provider if available, else nothing, then the
   fallbacks follow. Never resolves to the *other* vendor.
2. **Privacy: a `cloud`-location provider is only ever in a chain if the user put it there.** Defaults
   never auto-append cloud. (A user who didn't configure/opt-into cloud never has audio sent there.)
3. Unconfigured/unavailable providers are dropped (order preserved), never errored.
4. `browser` is always eligible as a terminal fallback but is a **client capability marker**, not a server
   call — the server chain covers spark/codex/cloud/macos; if it's exhausted (or the resolved primary is
   `browser`), the response tells the client to use the browser.

### Wiring
- `POST /api/transcribe` → `resolveChain('stt', …)` (extends today's candidate loop). Failure classes
  (critique): unconfigured→skip; codex 401/403→skip + provider status `needs-signin` (don't retry every
  utterance); timeout/5xx→fall through; 429→one backoff then fall through; empty→"no speech"; all-failed→
  one actionable error listing attempts. Server can't reach `browser` → if the chain is browser-only /
  exhausted, 409 `{useBrowser:true}` and the client's live recognizer handles it.
- `POST /api/tts` + `/api/tts/stream` → `resolveChain('tts', …)` (replaces the hardcoded
  spark→provider→local order). Only fall through **before playback starts** (client already respects this).
- `GET /api/voice/state` → `{ providers:[…], config:{tts,stt}, effective:{ttsChain,sttChain} }` for the UI.
  Booleans only; never leak tokens.

## UI (rewrite the `web/views/settings.js` voice section; mirror in classic `web/settings.js`)
Two primary rows + a collapsed fallback list each + a providers table. NO cards, NO matrix/graph.
```
Speaks (reports & voice)     Primary [ Spark ▾ ]      Fallbacks: macOS say → Browser   ⌄edit
Hears you (dictation)        Primary [ Match agent ▾ ] Fallbacks: Spark → Browser        ⌄edit
                             [ Manage providers ⌄ ]
```
- Primary dropdown lists only providers with that capability; each option shows availability
  (e.g. "Codex — sign in", "Claude — unavailable (browser-gated)" disabled).
- Fallbacks: collapsed by default; expand → a short reorderable list with enable checkboxes. Adding a
  cloud provider to a fallback shows a one-line "sends audio to <provider>" note (privacy, explicit).
- **Manage providers** (collapsed): a table, one row per provider — label, capability badges (TTS/STT),
  status chip (ok / sign-in / not configured / unavailable), inline config (Spark host/engine/voice;
  Cloud base_url+key; Codex sign-in link; Claude greyed with the reason), and a **Test** button per
  provider (TTS speaks a phrase; STT does a short mic capture). (kimi: Test is non-negotiable.)
- Failures surface here: a failing provider's row goes amber; a mic/speaker that fell back shows which
  provider actually served.

## Migration (config v1 → v2, once, `model_providers.js`)
On read, if `voice.version !== 2`, migrate and stamp v2, keeping a `_legacyVoice` blob for one release:
- Spark configured+enabled → `tts.primary='spark'`, and (if no explicit `sttSource`) `stt.primary` from
  the old dictation source, else `'match-agent'`. Old card `local` → spark; `gpt`/speech base_url → the
  `cloud` provider exists but is NOT auto-put in a chain unless it was the active choice.
- Old `sttSource` (auto/codex/spark/provider) → `stt.primary` (auto→match-agent; provider→cloud);
  `claude` → `match-agent` + a visible "Claude STT is unavailable" note.
- Old `sparkDisabled` true + a speech provider → `tts.primary='cloud'`; else browser.
- Default fallbacks: local/tailnet + browser only (never cloud unless it was already the choice).
Show a one-time "Voice settings upgraded" notice.

## Scope
IN: provider registry + capability model, config v2 + migration, TTS+STT resolver wired into the real
routes, the UI rewrite, honest Claude, per-provider Test, failure classification (skip/needs-signin/
fall-through), the privacy rule.
OUT (explicit follow-ups, not silently skipped): collapsing the **3 client TTS stacks**
(tts-player.js / voicemode.js / phone.js) into one — big, risky, orthogonal; this pass makes them all
resolve the same server config but leaves the triplicated code. Persistent per-provider cooldown/backoff
store (this pass does in-request classification only). Browser STT as a distinct manual-retry mode
(kept as today's live-recognizer behavior).

## Verify
- Unit: `resolveChain` for TTS and STT (privacy rule, match-agent, browser-terminal, availability filter);
  v1→v2 migration table.
- Isolated instance: `/api/voice/state` shape; `/api/tts` resolves the TTS chain; `/api/transcribe`
  resolves the STT chain; a real Codex STT (verified working) still returns `backend:'codex'`; Claude row
  shows unavailable.
- Browser: the new Voice UI renders, primary/fallback edits persist, Manage Providers table + Test buttons
  work, migration notice shows once.
- Full `npm test`; ship via the pipeline.
