// Pure speech/echo discrimination for Voice Assistant barge-in. Browser recognition runs while TTS
// is speaking, so most interim transcripts are the assistant hearing its own speaker. Only direct
// controls, questions, or corrections that are not already present in the spoken text may interrupt.

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(value) {
  return normalize(value).split(' ').filter(Boolean);
}

const CONTROL = /^(?:hey\s+(?:assistant|supercalm)\s+)?(?:stop|pause|wait|hold on|hang on|skip|next|repeat|go back)\b/;
const QUESTION = /^(?:hey\s+(?:assistant|supercalm)\s+)?(?:what|why|how|when|where|who|which|can|could|would|will|is|are|do|does|did|tell me|explain)\b/;
const CORRECTION = /^(?:hey\s+(?:assistant|supercalm)\s+)?(?:no\b|actually\b|thats not\b|that is not\b|i asked\b|i meant\b|i mean\b|i want\b|i need\b|dont\b|do not\b|please\b|make\b|use\b|send\b|show me\b|let me\b)/;
const CUE_ANYWHERE = /\b(?:stop|pause|wait|hold on|hang on|actually|thats not|that is not|i asked|i meant|i mean|tell me|explain|what|why|how|when|where|who|which|can|could|would)\b/g;
const RAW_CUE_ANYWHERE = /\b(?:stop|pause|wait|hold on|hang on|actually|that's not|that is not|i asked|i meant|i mean|tell me|explain|what|why|how|when|where|who|which|can|could|would)\b/gi;

export function isPlaybackEcho(heard, spoken) {
  const h = normalize(heard);
  const s = normalize(spoken);
  if (!h || !s) return false;
  if (s.includes(h) || h === s) return true;
  const heardWords = words(h);
  if (heardWords.length < 2) return false;
  const spokenWords = new Set(words(s));
  const overlap = heardWords.filter((word) => spokenWords.has(word)).length / heardWords.length;
  return overlap >= 0.85;
}

export function isClearVoiceInterruption(heard, spoken) {
  const h = normalize(heard);
  const s = normalize(spoken);
  if (!h) return false;
  // A verbatim/substantial fragment of the report is speaker echo, even when it starts with a word
  // such as "what". This check prevents the assistant from interrupting itself.
  if (isPlaybackEcho(h, s)) return false;
  if (CONTROL.test(h) || QUESTION.test(h) || CORRECTION.test(h)) return true;

  // Some engines retain the assistant's words before appending the operator's interruption. Accept
  // only a direct cue whose remaining phrase is genuinely new to the report.
  for (const match of h.matchAll(CUE_ANYWHERE)) {
    const suffix = h.slice(match.index).trim();
    if (suffix.split(' ').length >= 2 && !s.includes(suffix)) return true;
  }
  return false;
}

// Recognition can retain a few words of speaker echo before the operator's new phrase. Return only
// the direct interruption suffix so those repeated report lines never enter conversation history.
export function extractVoiceInterruption(heard, spoken) {
  const raw = String(heard || '').trim();
  if (!isClearVoiceInterruption(raw, spoken)) return '';
  const h = normalize(raw);
  if (CONTROL.test(h) || QUESTION.test(h) || CORRECTION.test(h)) return raw;
  const s = normalize(spoken);
  for (const match of raw.matchAll(RAW_CUE_ANYWHERE)) {
    const suffix = raw.slice(match.index).trim();
    if (suffix.split(/\s+/).length >= 2 && !s.includes(normalize(suffix))) return suffix;
  }
  return raw;
}
