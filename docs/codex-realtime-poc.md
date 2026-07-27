# Codex realtime voice proof of concept

This lab exposes the installed Codex CLI as a voice surface without replacing AIOS's existing recorder.

## What is implemented

- AIOS can initialize `codex app-server` with `experimentalApi: true`.
- With Platform API-key auth, AIOS creates an ephemeral Codex thread and negotiates native WebRTC realtime.
- With the existing ChatGPT login, AIOS automatically uses a working bridge: local Whisper input, an OpenAI Codex endpoint reached through a persistent local Codex App Server thread, and local Kokoro output.
- The bridge automatically creates a fresh Codex thread and retries the pending transcript once if an AIOS restart invalidates the active session.
- The OpenAI credential remains server-side. The browser receives only SDP and a random AIOS session id.
- The realtime prompt explicitly avoids canned trailing sign-offs such as "Thank you."

The implementation is isolated at `/aios/codex-realtime.html`. It does not change the existing voice button or blob-based transcription pipeline.

The JSONL protocol, auth selection, bridged voice turn, SDP exchange, transcript rendering, text fallback, and microphone cleanup are automated-test verified.

## Authentication modes

Codex CLI 0.142.5 exposes the realtime methods, but native speech-to-speech requires Platform API-key authentication. A normal ChatGPT/Codex login is rejected by that experimental method with:

```text
realtime conversation requires API key auth
```

No extra credential is required for the bridged mode. AIOS uses the existing ChatGPT-authenticated Codex CLI plus its existing local speech services. On this host, a short `gpt-5.3-codex-spark` bridge turn measured about seven seconds.

In bridged mode, microphone audio is sent only to AIOS and transcribed by the
local Whisper service. The transcript and conversation text are sent to the
OpenAI Codex endpoint for inference. The returned text is synthesized into
audio locally by Kokoro. Running `codex app-server` on the host does not make
the Codex model itself local; it is the local client for the authenticated
Codex service.

Before proposing optional native realtime, the standard operator locations were checked by key name only:

```text
process OPENAI_API_KEY: absent
~/.dev.vars OPENAI_API_KEY: absent
data/aios.env OPENAI_API_KEY: absent
```

To opt into native WebRTC later, use the existing gitignored `data/aios.env` rather than adding a tracked config file:

```dotenv
OPENAI_API_KEY=…
```

Restart AIOS after changing that file. The API key is used by the local Codex App Server process and is never returned to the browser. Platform API usage is billed separately from a ChatGPT subscription. Without it, the page remains usable in bridged mode.

## Try it

Run the protocol smoke test:

```sh
npm run poc:codex-realtime
```

Then start AIOS and open:

```text
https://YOUR-AIOS-HOST/aios/codex-realtime.html
```

The page reports the actual Codex auth type. With `apiKey` auth it uses native realtime; with `chatgpt` auth it automatically uses the working Codex bridge.

## Experimental boundary

`thread/realtime/*` is absent from the stable Codex CLI command surface and is marked `under development` in `codex features list`. The adapter is therefore kept in `src/codex_realtime_client.js`, separate from the existing voice implementation. Re-run the installed-version schema generator before upgrading Codex:

```sh
codex app-server generate-json-schema --experimental --out /tmp/codex-app-server-schema
```
