// Phone companion view API (web/phone.html) — the triage loop needs two things the desktop never
// tracked: per-message READ state (a key message is unread until played/answered — synced server-side
// so phone and desktop agree, design contract #7) and a single lean home payload (per-session unread
// counts + last key message) so the home screen is ONE fetch, not N+1.

import { route, json } from './server.js';
import { db, getSession } from './store.js';
import { bus } from './bus.js';
import { storyFor } from './story_api.js';

// r4 class C: the triage question a card shows must be the DERIVED question (last unanswered ask from
// the story parser, else the last report), never raw TUI scrollback ("bypass permissions on…",
// "100% context used", "shift+tab to cycle"). De-markdown + strip TUI chrome, cap 300 chars.
const TUI_CHROME_RX = /(?:▶▶?\s*)?bypass permissions on[^\n]*|\d{1,3}%\s*context\s*(?:used|left)[^\n]*|shift\+tab to cycle[^\n]*|esc to interrupt[^\n]*|for agents\s*$/gi;
function deMarkdown(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\|[^\n]*\|/g, ' ') // table rows
    .replace(/[#*`>_~]+/g, '')
    .replace(TUI_CHROME_RX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
async function deriveQuestion(sid, fallback = '') {
  try {
    const { events } = await storyFor(sid, { rounds: 3 });
    const asks = events.filter((e) => e.kind === 'ask' && !e.answered);
    let q = asks.length ? (asks[asks.length - 1].body || asks[asks.length - 1].title || '') : '';
    if (!q) { const reps = events.filter((e) => e.kind === 'report'); q = reps.length ? (reps[reps.length - 1].body || '') : ''; }
    q = deMarkdown(q).slice(0, 300);
    return q || deMarkdown(fallback).slice(0, 300);
  } catch { return deMarkdown(fallback).slice(0, 300); }
}

// additive migration: read_at on messages (nullable; desktop ignores it)
try { db.exec('ALTER TABLE messages ADD COLUMN read_at INTEGER'); } catch {}

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); req.on('error', () => resolve('')); });
}

// Key messages = agent-side waiting reports (direction 'out'). Unread = read_at IS NULL and newer
// than the operator's last reply in that session (an answer marks everything before it read — the
// design's "replying clears unread", enforced structurally).
const _unread = db.prepare(`
  SELECT m.session_id sid, COUNT(*) n, MAX(m.ts) last_ts
  FROM messages m
  WHERE m.direction = 'out' AND m.read_at IS NULL
    AND m.ts > COALESCE((SELECT MAX(ts) FROM messages i WHERE i.session_id = m.session_id AND i.direction = 'in'), 0)
  GROUP BY m.session_id`);
const _lastKey = db.prepare(`
  SELECT id, text, ts FROM messages
  WHERE session_id = ? AND direction = 'out'
  ORDER BY ts DESC LIMIT 1`);

export function unreadBySession() {
  const out = new Map();
  for (const r of _unread.all()) out.set(r.sid, { n: r.n, last_ts: r.last_ts });
  return out;
}

route('POST', '/api/messages/read', async (req, res) => {
  let b = {};
  try { b = JSON.parse(await readBody(req) || '{}'); } catch {}
  const ids = (Array.isArray(b.ids) ? b.ids : []).map((x) => Number(x)).filter(Number.isFinite).slice(0, 200);
  const sid = typeof b.session_id === 'string' ? b.session_id : null;
  const ts = Date.now();
  let n = 0;
  if (ids.length) {
    const q = db.prepare(`UPDATE messages SET read_at = ? WHERE id IN (${ids.map(() => '?').join(',')}) AND read_at IS NULL`);
    n = q.run(ts, ...ids).changes;
  } else if (sid) {
    n = db.prepare("UPDATE messages SET read_at = ? WHERE session_id = ? AND direction = 'out' AND read_at IS NULL").run(ts, sid).changes;
  } else {
    return json(res, 400, { error: 'ids[] or session_id required' });
  }
  if (n) bus.emit('changed');
  return json(res, 200, { ok: true, marked: n });
});

// Lean home payload: /api/state's session surface + unread counts + the last key message text.
route('GET', '/api/phone/home', async (req, res) => {
  const unread = unreadBySession();
  const rows = db.prepare(`
    SELECT s.id, s.title, s.tool, s.model, s.status, s.category, s.stage, s.summary, s.question, s.last_activity, s.started_at, p.name AS project
    FROM sessions s LEFT JOIN projects p ON p.id = s.project_id ORDER BY s.last_activity DESC LIMIT 120`).all();
  const sessions = await Promise.all(rows.map(async (s) => {
    const u = unread.get(s.id);
    const lastKey = u ? _lastKey.get(s.id) : null;
    // r4 class C: waiting cards get the derived question (story parser), not the raw detector tail.
    const question = s.status === 'waiting' ? await deriveQuestion(s.id, s.question || s.summary) : deMarkdown(s.question || '').slice(0, 300);
    return { ...s, question, unread: u?.n || 0, last_key: lastKey ? { id: lastKey.id, text: String(lastKey.text || '').slice(0, 500), ts: lastKey.ts } : null };
  }));
  const counts = {
    waiting: sessions.filter((s) => s.status === 'waiting').length,
    working: sessions.filter((s) => s.status === 'working').length,
    live: sessions.filter((s) => ['working', 'waiting'].includes(s.status)).length,
  };
  return json(res, 200, { ok: true, sessions, counts });
});
