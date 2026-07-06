// Saved prompt snippets — operator-global reusable prompts surfaced in the composer's "/" palette.
// Stored server-side (not localStorage) so they follow the operator across devices (phone <-> desktop).
// Tiny, self-contained: owns its own table + CRUD routes, like the other feature modules.
import crypto from 'node:crypto';
import { db } from './store.js';
import { route, json, readJson } from './server.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS prompt_snippets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER,
    updated_at INTEGER
  )
`);

const _all = db.prepare('SELECT id, name, body, updated_at FROM prompt_snippets ORDER BY name COLLATE NOCASE ASC');
const _get = db.prepare('SELECT id, name, body, updated_at FROM prompt_snippets WHERE id = ?');
const _byName = db.prepare('SELECT id FROM prompt_snippets WHERE name = ? COLLATE NOCASE');
const _insert = db.prepare('INSERT INTO prompt_snippets (id, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
const _update = db.prepare('UPDATE prompt_snippets SET name = ?, body = ?, updated_at = ? WHERE id = ?');
const _del = db.prepare('DELETE FROM prompt_snippets WHERE id = ?');

const NAME_MAX = 80;
const BODY_MAX = 20000;

route('GET', '/api/snippets', (req, res) => json(res, 200, { snippets: _all.all() }));

route('POST', '/api/snippets', async (req, res) => {
  const b = (await readJson(req)) || {};
  const name = String(b.name || '').trim().slice(0, NAME_MAX);
  const body = String(b.body || '').slice(0, BODY_MAX);
  if (!name || !body.trim()) return json(res, 400, { error: 'name and body required' });
  const now = Date.now();
  // Upsert by id (edit) or by name (save-over) so re-saving the same name doesn't pile up duplicates.
  const existing = b.id ? _get.get(b.id) : _byName.get(name);
  if (existing) {
    _update.run(name, body, now, existing.id);
    return json(res, 200, { snippet: _get.get(existing.id) });
  }
  const id = 'sn_' + crypto.randomBytes(6).toString('hex');
  _insert.run(id, name, body, now, now);
  json(res, 200, { snippet: _get.get(id) });
});

route('DELETE', '/api/snippets/:id', (req, res, { id }) => {
  _del.run(id);
  json(res, 200, { ok: true });
});

console.log('[aios] snippets module active');
