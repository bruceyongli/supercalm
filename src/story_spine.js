// Story spine — turn AIOS's OWN stored messages (the `messages` table) into attributed story events.
// This is the GUARANTEED story floor: when no native CLI transcript can be located (e.g. a codex session
// whose rollout cwd never matched — the s_8ea0dbf260 failure), the story is reconstructed from the real
// text AIOS captured, correctly attributed by each message's `source`. Pure + side-effect-free so it can
// be unit-tested without importing the server (store/sessions boot their poll loops on import).
//
// Why this also fixes the "mystery unattributed messages" report: every row carries a `source`, but the
// old fallback ignored it and rendered everything as a bare bubble. `out|detect` rows are terminal
// snapshots (e.g. "request failed 405", gcm ERROR spam — 12.8k of them), NOT conversation; agent/
// supervisor injections and cross-session relays must be labeled, not shown as the operator's own words.
//
// The `source` vocabulary (observed live) and how each maps:
//   in  · text / text+attachments / task / voice / operator / operator-correction → operator "you" bubble
//   in  · supervisor / agent:supervisor                                            → drop (machine steering)
//   in  · anything else (codex / claude-session / codex-coordination / …)          → labeled injection note
//   out · detect                                                                   → drop (terminal snapshot noise)
//   out · anything else                                                            → agent reply note

const OPERATOR_SOURCES = new Set([
  'text', 'text+attachments', 'task', 'voice', 'operator', 'operator-correction', 'phone', 'phone+attachments',
]);
const SUPERVISOR_SOURCES = new Set(['supervisor', 'agent:supervisor']);

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
// Multi-line clip for REPORT bodies: keeps line structure so markdown tables/headings/fences render
// as rich content in the story view (clip's \s+ collapse destroyed them — the "reports with table
// or rich content" fix). Trailing per-line spaces and 3+ blank-line runs still collapse.
function clipML(s, n) {
  const t = String(s || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Map one stored message row `{ts, direction, source, text}` → a story event, or null to drop it.
export function messageToEvent(m) {
  if (!m) return null;
  const ts = m.ts;
  const src = String(m.source || '').trim();
  const text = String(m.text || '').trim();
  if (!text) return null;

  if (m.direction === 'out') {
    if (src === 'detect') return null;             // terminal snapshots — status noise, not conversation
    return { ts, kind: 'note', text: clip(text, 600) };
  }
  // direction === 'in'
  if (SUPERVISOR_SOURCES.has(src)) return null;    // supervisor nudges are machine steering — kept out (policy)
  if (OPERATOR_SOURCES.has(src)) {
    const ev = { ts, kind: 'you', text: clip(text, 800) };
    if (src.endsWith('+attachments')) ev.chips = ['attachments'];
    return ev;
  }
  // any other inbound source = an agent/coordination message posted into this session → attribute it,
  // so it can never masquerade as the operator's own message (the operator's exact complaint).
  const who = src.replace(/^agent:/, '') || 'agent';
  return { ts, kind: 'sys', text: `[${who}] ${clip(text, 400)}` };
}

// Build the attributed spine from message rows (already in ascending ts order).
// The LAST agent reply is promoted to kind:'report' (mirrors buildStory's trailing note→report,
// src/story.js) so fallback stories get the report treatment too — incl. the listen button. It is
// re-derived from the ROW with a 4000-char clip: the 600-char note clip is a stub, not a listenable
// report source.
export function spineFromMessages(rows) {
  const list = rows || [];
  const out = list.map(messageToEvent);
  // Promote each agent turn's FINAL reply to 'report' (re-clipped to a full 4000 chars — the 600-char
  // note is a stub, not a listenable source) so EVERY historical report gets the listen button, not just
  // the newest (operator: "voice report should appear in all history reports"). A reply ends a turn when
  // the next surviving event hands back to the operator ('you') or the story ends. Mirrors buildStory.
  for (let i = 0; i < out.length; i++) {
    if (!out[i] || out[i].kind !== 'note') continue;
    let j = i + 1;
    while (j < out.length && !out[j]) j++; // skip dropped rows (detect noise)
    if (j >= out.length || out[j].kind === 'you') out[i] = { ts: list[i].ts, kind: 'report', text: clipML(list[i].text, 4000) };
  }
  return out.filter(Boolean);
}
