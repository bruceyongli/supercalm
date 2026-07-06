import { route, json } from './server.js';
import { db } from './store.js';

// Records browser: the stored `messages` (your inputs + the auto-extracted waiting questions),
// joined with session + project metadata, filterable by project / session / tool / model /
// source / direction / date range / free text, paginated. Read-only.
//
// `in/text`,`in/task`,`in/voice` = what YOU sent; `out/detect` = the question Supercalm extracted when
// a session went waiting. Full agent output lives in the raw per-session terminal log (link to the
// session page for that). The `db` handle is the same node:sqlite instance store.js opened.

const SELECT = `
  SELECT m.id, m.ts, m.direction, m.source, m.text, m.session_id,
         s.tool, s.model, s.title, s.project_id, p.name AS project
  FROM messages m
  JOIN sessions s ON s.id = m.session_id
  LEFT JOIN projects p ON p.id = s.project_id`;

route('GET', '/api/records', (req, res, _params, url) => {
  const q = url.searchParams;
  const where = [];
  const args = [];
  const eq = (sql, v) => { if (v) { where.push(sql); args.push(v); } };
  eq('s.project_id = ?', q.get('project'));
  eq('m.session_id = ?', q.get('session'));
  eq('s.tool = ?', q.get('tool'));
  eq('s.model = ?', q.get('model'));
  eq('m.source = ?', q.get('source'));
  eq('m.direction = ?', q.get('direction'));
  const since = Number(q.get('since')); if (since > 0) { where.push('m.ts >= ?'); args.push(since); }
  const until = Number(q.get('until')); if (until > 0) { where.push('m.ts <= ?'); args.push(until); }
  const text = (q.get('q') || '').trim();
  if (text) { where.push("m.text LIKE ? ESCAPE '\\'"); args.push('%' + text.replace(/[\\%_]/g, (c) => '\\' + c) + '%'); }

  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(1000, Math.max(1, Number(q.get('limit')) || 100));
  const offset = Math.max(0, Number(q.get('offset')) || 0);

  try {
    const total = db.prepare(`SELECT COUNT(*) n FROM messages m JOIN sessions s ON s.id = m.session_id LEFT JOIN projects p ON p.id = s.project_id ${W}`).get(...args).n;
    const records = db.prepare(`${SELECT} ${W} ORDER BY m.ts DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    json(res, 200, { total, limit, offset, count: records.length, records });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

// Decision events (ask -> response): the training-grade history. Filter by project / session /
// tool / model / category / status / date range / free text (over summary, ask, response, question).
route('GET', '/api/decisions', (req, res, _params, url) => {
  const q = url.searchParams;
  const where = [];
  const args = [];
  const eq = (sql, v) => { if (v) { where.push(sql); args.push(v); } };
  eq('project_id = ?', q.get('project'));
  eq('session_id = ?', q.get('session'));
  eq('tool = ?', q.get('tool'));
  eq('model = ?', q.get('model'));
  eq('category = ?', q.get('category'));
  eq('status = ?', q.get('status'));
  const since = Number(q.get('since')); if (since > 0) { where.push('asked_at >= ?'); args.push(since); }
  const until = Number(q.get('until')); if (until > 0) { where.push('asked_at <= ?'); args.push(until); }
  const text = (q.get('q') || '').trim();
  if (text) {
    const like = '%' + text.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    where.push("(summary LIKE ? ESCAPE '\\' OR ask LIKE ? ESCAPE '\\' OR response LIKE ? ESCAPE '\\' OR question LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(2000, Math.max(1, Number(q.get('limit')) || 50));
  const offset = Math.max(0, Number(q.get('offset')) || 0);
  try {
    const total = db.prepare(`SELECT COUNT(*) n FROM decisions ${W}`).get(...args).n;
    const records = db.prepare(`SELECT * FROM decisions ${W} ORDER BY asked_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    json(res, 200, { total, limit, offset, count: records.length, records });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

console.log('[aios] records browser ready (/api/records, /api/decisions)');
