import { SPARK } from './config.js';
import { getVoiceOverride, getSpeech } from './model_providers.js';
import { codexSttAvailable } from './stt_codex.js';

// The voice PROVIDER REGISTRY: every speech source as a provider with capabilities + live status.
// Kept free of spark.js/tts.js imports (they import US, via the resolver) — availability is computed
// from raw config here to avoid an import cycle. See docs/specs/voice-providers-redesign.md.

const SUBSCRIPTION_STT_ON = !/^(0|false|off|no)$/i.test(process.env.AIOS_STT_SUBSCRIPTION || '1');

export const VOICE_PROVIDER_IDS = ['spark', 'codex', 'claude', 'cloud', 'macos', 'browser'];

// Async because codex availability reads ~/.codex/auth.json. Returns the full registry (for the UI).
export async function voiceProviders() {
  const ov = getVoiceOverride();
  const sparkIp = ov?.spark?.ip || SPARK.ip;
  const sparkMuted = !!ov?.sparkDisabled;
  const speech = getSpeech({ redact: false });
  const cloudOn = !!(speech?.enabled && speech.base_url);
  const codexOn = SUBSCRIPTION_STT_ON && (await codexSttAvailable());

  return [
    {
      id: 'spark', label: 'Local voice (Spark)', caps: { tts: true, stt: true }, location: 'tailnet',
      configured: !!sparkIp, available: !!sparkIp && !sparkMuted,
      status: !sparkIp ? 'not-configured' : sparkMuted ? 'unavailable' : 'ok',
      detail: !sparkIp ? 'set SPARK_IP / SPARK_HOST' : sparkMuted ? 'muted' : 'Whisper + Kokoro, on your tailnet',
    },
    {
      id: 'codex', label: 'Codex — your ChatGPT login', caps: { tts: false, stt: true }, location: 'cloud',
      configured: codexOn, available: codexOn, unofficial: true,
      status: !SUBSCRIPTION_STT_ON ? 'unavailable' : codexOn ? 'ok' : 'needs-signin',
      detail: !SUBSCRIPTION_STT_ON ? 'disabled by AIOS_STT_SUBSCRIPTION' : codexOn ? 'unofficial endpoint · your own ChatGPT account' : 'sign in to Codex to enable',
    },
    {
      id: 'claude', label: 'Claude', caps: { tts: false, stt: true }, location: 'cloud',
      configured: false, available: false, status: 'unavailable',
      detail: "browser-gated — Claude's dictation has no headless API",
    },
    {
      id: 'cloud', label: 'Cloud provider (OpenAI-compatible)', caps: { tts: true, stt: true }, location: 'cloud',
      configured: cloudOn, available: cloudOn, status: cloudOn ? 'ok' : 'not-configured',
      detail: cloudOn ? speech.base_url : 'add an OpenAI-compatible provider',
    },
    {
      id: 'macos', label: 'macOS say', caps: { tts: true, stt: false }, location: 'server',
      configured: true, available: true, status: 'ok', detail: 'built-in TTS fallback',
    },
    {
      id: 'browser', label: 'Browser (on-device)', caps: { tts: true, stt: true }, location: 'browser',
      configured: true, available: true, status: 'ok', detail: 'no setup; instant; lower quality',
    },
  ];
}

// {id: {caps, available, location}} — the shape the pure resolver consumes.
export function availabilityMap(providers) {
  const m = {};
  for (const p of providers) m[p.id] = { caps: p.caps, available: p.available, location: p.location };
  return m;
}
