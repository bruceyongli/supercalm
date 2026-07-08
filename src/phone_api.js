// Phone companion view API (web/phone.html) — the triage loop needs two things the desktop never
// tracked: per-message READ state (a key message is unread until played/answered — synced server-side
// so phone and desktop agree, design contract #7) and a single lean home payload (per-session unread
// counts + last key message) so the home screen is ONE fetch, not N+1.

import { route, json } from './server.js';
import { db, getSession } from './store.js';
import { bus } from './bus.js';

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
route('GET', '/api/phone/home', (req, res) => {
  const unread = unreadBySession();
  const rows = db.prepare(`
    SELECT id, title, tool, model, status, category, stage, summary, question, last_activity, started_at
    FROM sessions ORDER BY last_activity DESC LIMIT 120`).all();
  const sessions = rows.map((s) => {
    const u = unread.get(s.id);
    const lastKey = u ? _lastKey.get(s.id) : null;
    return { ...s, unread: u?.n || 0, last_key: lastKey ? { id: lastKey.id, text: String(lastKey.text || '').slice(0, 500), ts: lastKey.ts } : null };
  });
  const counts = {
    waiting: sessions.filter((s) => s.status === 'waiting').length,
    working: sessions.filter((s) => s.status === 'working').length,
    live: sessions.filter((s) => ['working', 'waiting'].includes(s.status)).length,
  };
  return json(res, 200, { ok: true, sessions, counts });
});
