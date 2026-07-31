// One transcript acceptance policy for phone, desktop, and the server. Audio capture can differ by
// browser, but a clipped syllable, speaker echo, or punctuation fragment must never become a model turn.

const SHORT_INTENT = new Set([
  'yes', 'yeah', 'yep', 'no', 'nope', 'ok', 'okay', 'sure', 'send', 'stop', 'pause', 'wait', 'next',
  'skip', 'later', 'done', 'repeat', 'continue', 'why', 'what', 'how', 'when', 'where', 'who', 'which',
  '好', '不', '停', '继续', '下一个',
]);

export const VOICE_CAPTURE_DEFAULTS = Object.freeze({
  threshold: 0.045,
  silenceMs: 1800,
  graceMs: 8000,
  minSpeechMs: 500,
});

function normalized(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  return normalized(value).match(/[\p{L}\p{N}]+/gu) || [];
}

export function voiceTranscriptDisposition(text, { spoken = '' } = {}) {
  const clean = normalized(text);
  if (!clean) return { accepted: false, reason: 'no-speech', text: '' };
  if (SHORT_INTENT.has(clean)) return { accepted: true, reason: '', text: String(text).trim() };

  const parts = tokens(clean);
  const compact = clean.replace(/\s/g, '');
  // Spark occasionally returns one clipped letter/syllable for room noise. It has no safe semantic
  // interpretation and was the source of the iPhone's self-sustaining answer loop.
  if (!parts.length || compact.length < 3 || (parts.length === 1 && compact.length < 4)) {
    return { accepted: false, reason: 'fragment', text: '' };
  }

  const said = normalized(spoken);
  // During the handoff from TTS to VAD, iOS can transcribe the tail of the assistant's own sentence.
  // Explicit controls above still work, but report text never re-enters the conversation as user speech.
  if (said && (said.includes(clean) || clean === said)) {
    return { accepted: false, reason: 'playback-echo', text: '' };
  }
  return { accepted: true, reason: '', text: String(text).trim() };
}
