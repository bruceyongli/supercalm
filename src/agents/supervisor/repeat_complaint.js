// REPEATED-COMPLAINT DETECTION (v4 Phase 4, traceability A4): "I'm tired of reporting the same
// issue again and again" was a verbatim operator quote in the review — the same instruction needed
// 2–7 re-sends because nothing NOTICED the repetition. This detects when the operator's recent
// messages re-raise the same complaint and turns it into a red-flag the supervisor must surface
// with top priority (escalate-once; the repeat itself is the evidence). PURE module.

const STOP = new Set(['the','a','an','is','are','was','be','to','of','and','or','in','on','it','this','that','you','i','we','not','still','again','please','can','fix','issue','same','now','with','for','my','your']);

function tokens(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w)));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

// messages: [{ ts, text }] newest-first (the snapshot's recentSignals shape). A repeat = two
// messages ≥ minGapMs apart with token similarity ≥ threshold — re-phrasings count, immediate
// double-sends (impatient Enter) don't.
export function detectRepeatedComplaint(messages = [], { threshold = 0.45, minGapMs = 3 * 60_000, window = 8 } = {}) {
  const ms = messages.slice(0, window).filter((m) => m && m.text && String(m.text).trim().length >= 12);
  for (let i = 0; i < ms.length; i++) {
    const ti = tokens(ms[i].text);
    if (ti.size < 3) continue;
    for (let j = i + 1; j < ms.length; j++) {
      if (Math.abs((ms[i].ts || 0) - (ms[j].ts || 0)) < minGapMs) continue;
      const sim = jaccard(ti, tokens(ms[j].text));
      if (sim >= threshold) {
        return {
          repeated: true,
          similarity: Number(sim.toFixed(2)),
          latest: { ts: ms[i].ts, text: String(ms[i].text).slice(0, 180) },
          earlier: { ts: ms[j].ts, text: String(ms[j].text).slice(0, 180) },
          key: 'rep|' + [ms[j].ts, ms[i].ts].join('|'),
        };
      }
    }
  }
  return { repeated: false };
}
