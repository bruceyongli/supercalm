// Phone companion view API (web/phone.html) — the triage loop needs two things the desktop never
// tracked: per-message READ state (a key message is unread until played/answered — synced server-side
// so phone and desktop agree, design contract #7) and a single lean home payload (per-session unread
// counts + last key message) so the home screen is ONE fetch, not N+1.

import { route, json } from './server.js';
import { db } from './store.js';
import { bus } from './bus.js';
import {
  attentionUnreadCount,
  dismissAttention,
  listAttentionDismissals,
  restoreAttention,
} from './attention_store.js';

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
function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); req.on('error', () => resolve('')); });
}

// Key messages = agent-side waiting reports (direction 'out'). Unread = read_at IS NULL and later
// than the operator's last reply in that session (an answer marks everything before it read — the
// design's "replying clears unread", enforced structurally). Message ids, not millisecond timestamps,
// define causal order: a reply and immediate report can legitimately share one timestamp.
const _unread = db.prepare(`
  WITH last_in AS (
    SELECT session_id, MAX(id) last_id
    FROM messages
    WHERE direction = 'in'
    GROUP BY session_id
  )
  SELECT m.session_id sid, COUNT(*) n, MAX(m.ts) last_ts
  FROM messages m
  LEFT JOIN last_in i ON i.session_id = m.session_id
  WHERE m.direction = 'out' AND m.read_at IS NULL
    AND m.id > COALESCE(i.last_id, 0)
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
  const wantsDismissal = b.dismiss === true;
  // Inbox dismissal is bounded to the newest report visible when the operator clicked. This avoids a
  // report arriving during the request being swept away by the session-wide read operation: messages
  // through this id disappear, while any later work-status report remains unread and reopens the card.
  const throughId = Number.isSafeInteger(Number(b.through_id)) && Number(b.through_id) > 0 ? Number(b.through_id) : null;
  const ts = Date.now();
  let n = 0;
  let dismissal = null;
  const touched = new Set(sid ? [sid] : []);
  if (wantsDismissal) {
    if (!sid) return json(res, 400, { error: 'session_id required for dismissal' });
    const before = attentionUnreadCount(sid);
    dismissal = dismissAttention(sid, throughId, ts);
    if (!dismissal) return json(res, 404, { error: 'attention report not found' });
    n = Math.max(0, before - attentionUnreadCount(sid));
  } else if (ids.length) {
    const rows = db.prepare(`SELECT DISTINCT session_id FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    for (const row of rows) if (row.session_id) touched.add(row.session_id);
    const q = db.prepare(`UPDATE messages SET read_at = ? WHERE id IN (${ids.map(() => '?').join(',')}) AND read_at IS NULL`);
    n = q.run(ts, ...ids).changes;
  } else if (sid && throughId) {
    n = db.prepare("UPDATE messages SET read_at = ? WHERE session_id = ? AND direction = 'out' AND id <= ? AND read_at IS NULL").run(ts, sid, throughId).changes;
  } else if (sid) {
    n = db.prepare("UPDATE messages SET read_at = ? WHERE session_id = ? AND direction = 'out' AND read_at IS NULL").run(ts, sid).changes;
  } else {
    return json(res, 400, { error: 'ids[] or session_id required' });
  }
  const unread = unreadBySession();
  if (n || dismissal) {
    // The normalized clients intentionally ignore broad `changed` invalidations. Publish only the
    // affected unread counters so another desktop/phone reconciles immediately without reloading home.
    for (const session of touched) bus.emit('session-status', {
      session,
      unread: unread.get(session)?.n || 0,
      ...(dismissal ? {
        dismissed: !!dismissal.dismissed,
        dismissed_at: dismissal.dismissed ? dismissal.dismissed_at : null,
        dismissed_report_id: dismissal.dismissed ? dismissal.report_id : null,
        dismissed_report_text: dismissal.dismissed ? dismissal.report_text : null,
      } : {}),
      source: dismissal ? 'dismiss' : 'read',
      ts,
    });
    bus.emit('changed'); // legacy clients remain compatible during the transition
  }
  return json(res, 200, {
    ok: true,
    marked: n,
    ...(dismissal ? { dismissal } : {}),
    ...(sid ? { unread: unread.get(sid)?.n || 0 } : {}),
  });
});

route('POST', '/api/attention/:id/restore', async (req, res, { id: sid }) => {
  const result = restoreAttention(sid);
  if (!result.restored) return json(res, 404, { error: 'dismissed attention report not found' });
  const ts = Date.now();
  bus.emit('session-status', {
    session: sid,
    unread: result.unread,
    dismissed: false,
    dismissed_at: null,
    dismissed_report_id: null,
    dismissed_report_text: null,
    source: 'attention-restore',
    ts,
  });
  bus.emit('changed');
  return json(res, 200, { ok: true, ...result });
});

// Lean home payload: /api/state's session surface + unread counts + the last key message text.
route('GET', '/api/phone/home', async (req, res) => {
  const unread = unreadBySession();
  const dismissals = new Map(listAttentionDismissals().map((d) => [d.session_id, d]));
  const rows = db.prepare(`
    WITH recent AS (
      SELECT id FROM sessions ORDER BY last_activity DESC LIMIT 120
    )
    SELECT s.id, s.project_id, s.title, s.tool, s.model, s.status, s.category, s.stage, s.summary, s.question, s.last_activity, s.started_at, s.revision, p.name AS project
    FROM sessions s
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE s.id IN (SELECT id FROM recent)
       OR EXISTS (SELECT 1 FROM attention_dismissals d WHERE d.session_id = s.id)
    ORDER BY s.last_activity DESC`).all();
  const sessions = rows.map((s) => {
    const u = unread.get(s.id);
    const dismissal = dismissals.get(s.id);
    const lastKey = u || dismissal ? _lastKey.get(s.id) : null;
    // The waiting transition already persists a model-cleaned summary/category. Home is a database-only
    // projection: transcript/story parsing here made one list refresh scale with every waiting log.
    const question = deMarkdown(s.question || s.summary || '').slice(0, 300);
    return {
      ...s,
      question,
      unread: u?.n || 0,
      last_key: lastKey ? { id: lastKey.id, text: String(lastKey.text || '').slice(0, 500), ts: lastKey.ts } : null,
      dismissed: !!dismissal,
      dismissed_at: dismissal?.dismissed_at || null,
      dismissed_report_id: dismissal?.report_id || null,
      dismissed_report_text: dismissal?.report_text || null,
    };
  });
  const counts = {
    waiting: sessions.filter((s) => s.status === 'waiting').length,
    working: sessions.filter((s) => s.status === 'working').length,
    live: sessions.filter((s) => ['starting', 'working', 'waiting'].includes(s.status)).length,
    dismissed: sessions.filter((s) => s.dismissed).length,
  };
  return json(res, 200, { ok: true, sessions, counts });
});
