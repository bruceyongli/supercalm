// Pure voice-source resolver — one function for BOTH capabilities (TTS + STT). Unit-tested in
// test/voice_chain.test.js. Turns a per-capability selection (primary + ordered fallbacks) + the live
// provider availability + an optional agent hint into the ordered list of provider ids to try.
//
// Design (from docs/specs/voice-providers-redesign.md + the gpt-5.6/kimi critique):
//   - `match-agent` (STT only) is a POLICY, not a provider: it resolves to the hinted agent's provider
//     if that provider is available for STT, else it contributes nothing — then the fallbacks follow.
//     It NEVER resolves to the other subscription vendor.
//   - The PRIVACY rule (a cloud provider is only ever in a chain the user put it in) is enforced where
//     DEFAULTS are built (model_providers config), NOT here — this resolver only filters the user's
//     explicit selection by capability + availability. So it stays pure and honest to the config.
//   - Unavailable / wrong-capability providers are dropped, order preserved, deduped.
//   - `browser` is a normal entry here (always "available"); the CALLER decides what a browser entry
//     means (server can't invoke it — it's a client-side terminal fallback).

export const AGENT_STT = { codex: 'codex', claude: 'claude' }; // agent tool -> its STT provider id

// Parse the ?agent= hint into a subscription STT provider (codex|claude), else null (agy / unknown).
export function normalizeAgentHint(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'codex' || s === 'claude' ? s : null;
}

// avail: { [id]: { caps: {tts,stt}, available: bool } }
export function resolveChain({ capability, primary, fallbacks = [], avail = {}, agentHint = null } = {}) {
  const cap = capability === 'tts' ? 'tts' : 'stt';
  const canServe = (id) => {
    const p = avail[id];
    return !!(p && p.available && p.caps && p.caps[cap]);
  };
  const ordered = [];
  // primary
  if (primary === 'match-agent' && cap === 'stt') {
    const id = agentHint ? AGENT_STT[agentHint] : null; // codex/claude, or null (no hint / agy)
    if (id && canServe(id)) ordered.push(id); // else the policy contributes nothing; fallbacks follow
  } else if (primary && primary !== 'match-agent') {
    ordered.push(primary);
  }
  // fallbacks (a bare 'match-agent' in fallbacks is ignored — it's only meaningful as the primary policy)
  for (const f of fallbacks) if (f && f !== 'match-agent') ordered.push(f);
  // filter to capable+available, dedup, preserve order
  const seen = new Set();
  return ordered.filter((id) => canServe(id) && !seen.has(id) && seen.add(id));
}
