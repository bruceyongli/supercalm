// One semantic split for every Needs-you surface.
//
// A waiting session can contain two useful pieces of information:
//   1. the latest outcome/context from the agent;
//   2. a distinct action or decision for the operator.
//
// The home projection sometimes puts the same report in both `summary` and `question` (with one field
// merely truncated). Treating those as two concepts produced a repeated Latest + Needs you card. Only
// action/decision categories or a question genuinely different from the summary earn "Your move".

export function cleanAttentionText(value, max = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function comparable(value) {
  return cleanAttentionText(value, 1200)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function sameAttentionMessage(left, right) {
  const a = comparable(left);
  const b = comparable(right);
  if (!a || !b) return false;
  if (a === b) return true;
  // Reports are independently truncated by the home projection. A substantial prefix/substring is
  // the same message, not a second operator request.
  return Math.min(a.length, b.length) >= 64 && (a.includes(b) || b.includes(a));
}

export function attentionCopy({
  question,
  summary,
  fallback,
  category,
} = {}) {
  const ask = cleanAttentionText(question, 300);
  const update = cleanAttentionText(summary, 300);
  const report = cleanAttentionText(fallback, 300);
  const explicitlyActionable = category === 'action' || category === 'decision';

  if (ask && update && !sameAttentionMessage(ask, update)) {
    return { latest: cleanAttentionText(update, 220), action: ask, mode: 'split' };
  }
  if (ask && explicitlyActionable) {
    return { latest: '', action: ask, mode: 'action' };
  }
  if (ask || update) {
    const single = ask.length >= update.length ? ask : update;
    return { latest: single, action: '', mode: 'update' };
  }
  return { latest: report, action: '', mode: 'update' };
}
