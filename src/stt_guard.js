// STT output guard + context grounding (operator 2026-08-12: "voice mode still generates some
// nonsense … what the heck kind of language. It's not actually read the context and use the
// context to record the task"). Whisper with language=auto on short/noisy/silent audio emits stock
// hallucination phrases in random languages ("Продолжение следует…", "Thanks for watching", bare
// "you"), and that text was recorded VERBATIM as tasks/replies/titles — which the voice briefing
// then templated into absurd speech. This module is the class fix, applied inside /api/transcribe
// so every mic surface (composer, new-session task, phone, voice assistant) is covered:
//   1. guardTranscript()  — reject known stock hallucinations + transcripts whose dominant script
//                           is impossible for the allowed languages (fail-open when no langs given).
//   2. sttContextPrompt() — build a Whisper biasing prompt from the REAL session/project context,
//                           grounding decoding in the operator's actual vocabulary and language.
// Pure functions, no I/O — unit-tested in test/stt_guard.test.js.

// Stock phrases Whisper emits on silence/noise (community-documented across languages). A transcript
// is a hallucination ONLY when, after normalization, it consists ENTIRELY of one of these (optionally
// repeated — Whisper loops them). Substrings inside real speech are never rejected.
const STOCK_PHRASES = [
  // English
  'you', 'bye', 'thank you', 'thanks for watching', 'thank you for watching',
  'thanks for watching and see you in the next video', 'please subscribe',
  'subtitles by the amara org community', 'this video is a derivative work',
  // Russian
  'продолжение следует', 'спасибо за просмотр', 'субтитры сделал dimatorzok',
  'субтитры создавал dimatorzok', 'редактор субтитров а семкин корректор а егорова',
  // Chinese
  '谢谢观看', '谢谢大家观看', '字幕由amara org社区提供', '请不吝点赞订阅转发打赏支持明镜与点点栏目',
  '中文字幕志愿者', '明镜与点点栏目',
  // Japanese / Korean
  'ご視聴ありがとうございました', 'おやすみなさい', '시청해주셔서감사합니다', 'mbc뉴스',
  // French / German / Spanish / Portuguese / Italian
  'sous titres realises para la communaute d amara org', 'sous titres realises par la communaute d amara org',
  'untertitel im auftrag des zdf fur funk 2017', 'untertitelung des zdf fur funk 2017', 'untertitel von stephanie geiges',
  'subtitulos realizados por la comunidad de amara org', 'subtitulos por la comunidad de amara org',
  'legendas pela comunidade amara org', 'sottotitoli creati dalla comunita amara org',
  'sottotitoli e revisione a cura di qtss',
];

// Normalize for stock matching: lowercase, strip diacritics where trivial, drop everything that is
// not a letter/digit in any script. This makes "Продолжение следует..." and "продолжение следует"
// compare equal, and glues CJK phrases regardless of spacing/fullwidth punctuation.
export function normalizeStock(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const STOCK_SET = new Set(STOCK_PHRASES.map(normalizeStock));

// True when the whole transcript is one stock phrase, optionally repeated (Whisper loops).
export function isStockHallucination(text) {
  const whole = normalizeStock(text);
  if (!whole) return false;
  if (STOCK_SET.has(whole)) return true;
  for (const phrase of STOCK_SET) {
    if (!phrase || phrase.length < 3) continue; // never repeat-match ultra-short entries like "you"
    if (whole.length % phrase.length === 0 && whole.length / phrase.length <= 40 && phrase.repeat(whole.length / phrase.length) === whole) return true;
  }
  return false;
}

// ---- script detection (cheap, dependency-free) --------------------------------------------------
const SCRIPT_RANGES = [
  ['latin', /[a-zÀ-ɏ]/iu],
  ['cyrillic', /[Ѐ-ӿ]/u],
  ['cjk', /[㐀-䶿一-鿿豈-﫿]/u],
  ['kana', /[぀-ヿ]/u],
  ['hangul', /[가-힯ᄀ-ᇿ]/u],
  ['arabic', /[؀-ۿ]/u],
  ['hebrew', /[֐-׿]/u],
  ['greek', /[Ͱ-Ͽ]/u],
  ['devanagari', /[ऀ-ॿ]/u],
  ['thai', /[฀-๿]/u],
];

// Which scripts each (base) language legitimately uses. Languages absent from this map allow latin,
// which fails open for most of the long tail.
const LANG_SCRIPTS = {
  en: ['latin'], de: ['latin'], fr: ['latin'], es: ['latin'], pt: ['latin'], it: ['latin'],
  nl: ['latin'], sv: ['latin'], no: ['latin'], da: ['latin'], fi: ['latin'], pl: ['latin'],
  cs: ['latin'], tr: ['latin'], vi: ['latin'], id: ['latin'], ms: ['latin'],
  ru: ['cyrillic'], uk: ['cyrillic'], bg: ['cyrillic'], sr: ['cyrillic', 'latin'],
  zh: ['cjk'], ja: ['cjk', 'kana'], ko: ['hangul', 'cjk'],
  ar: ['arabic'], fa: ['arabic'], ur: ['arabic'], he: ['hebrew'], el: ['greek'],
  hi: ['devanagari'], mr: ['devanagari'], th: ['thai'],
};

export function scriptCounts(text) {
  const counts = {};
  for (const ch of String(text || '')) {
    for (const [name, rx] of SCRIPT_RANGES) {
      if (rx.test(ch)) { counts[name] = (counts[name] || 0) + 1; break; }
    }
  }
  return counts;
}

export function normalizeLangs(langs) {
  const list = Array.isArray(langs) ? langs : String(langs || '').split(',');
  const out = [];
  for (const raw of list) {
    const base = String(raw || '').trim().toLowerCase().split(/[-_]/)[0];
    if (/^[a-z]{2,3}$/.test(base) && !out.includes(base)) out.push(base);
  }
  return out;
}

// True when the transcript's letters are dominated (≥60%, and at least 8 letters) by scripts that
// NONE of the allowed languages can produce — e.g. a Cyrillic transcript when the operator speaks
// en/zh. Empty langs → never violates (fail-open for callers that opt out).
export function violatesLanguages(text, langs) {
  const allowedLangs = normalizeLangs(langs);
  if (!allowedLangs.length) return false;
  const allowed = new Set(allowedLangs.flatMap((l) => LANG_SCRIPTS[l] || ['latin']));
  const counts = scriptCounts(text);
  let total = 0;
  let disallowed = 0;
  for (const [script, n] of Object.entries(counts)) {
    total += n;
    if (!allowed.has(script)) disallowed += n;
  }
  return total >= 8 && disallowed / total >= 0.6;
}

// The single gate /api/transcribe puts every backend's output through.
export function guardTranscript(text, { langs } = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: true, text: '' };
  if (isStockHallucination(trimmed)) return { ok: false, text: '', rejected: 'hallucination', raw: trimmed };
  if (violatesLanguages(trimmed, langs)) return { ok: false, text: '', rejected: 'language', raw: trimmed };
  return { ok: true, text: trimmed };
}

// Whisper biasing prompt built from the REAL context ("read the context and use the context").
// An English-vocabulary prompt also biases language detection toward the operator's working
// language, which is half the wrong-language battle. Capped hard — Whisper only reads ~224 tokens.
export function sttContextPrompt({ project, session, extra } = {}) {
  const parts = ['Supercalm coding session dictation.'];
  const name = String(project?.name || '').trim();
  if (name) parts.push(`Project: ${name}.`);
  const tool = String(session?.tool || '').trim();
  if (tool) parts.push(`Agent: ${tool}.`);
  const title = String(session?.title || session?.task || '').split('\n')[0].trim();
  if (title) parts.push(`Task: ${title}`);
  if (extra) parts.push(String(extra));
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, 600).trim();
}
