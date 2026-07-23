import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-phone-'));
const port = 30000 + Math.floor(Math.random() * 9000);
process.env.AIOS_PORT = String(port); // phone_api pulls in server.js — keep it off the live port

const { db, addMessage } = await import('../src/store.js');
const { recordUsage } = await import('../src/usage_store.js');
const { unreadBySession } = await import('../src/phone_api.js');
const { bus } = await import('../src/bus.js');

// seed a session + conversation shape: out (old) -> in (reply) -> out, out (new episode)
// Keep the fixture lifecycle-terminal so importing the real session monitor during the full suite cannot
// concurrently retire its intentionally nonexistent tmux pane. Read/dismiss semantics are status-agnostic.
db.prepare("INSERT INTO sessions (id, project_id, tool, tmux, status, started_at, last_activity) VALUES ('s_ph','p_ph','codex','tmx_ph','exited', 1, 1)").run();
addMessage('s_ph', 'out', 'detect', 'old report before the reply');
await new Promise((r) => setTimeout(r, 5));
addMessage('s_ph', 'in', 'text', 'operator replied here');
await new Promise((r) => setTimeout(r, 5));
addMessage('s_ph', 'out', 'detect', 'new report A after the reply');
addMessage('s_ph', 'out', 'detect', 'new report B after the reply');

// ---- unread semantics: only out-messages NEWER than the last operator reply count ------------------
{
  const u = unreadBySession().get('s_ph');
  assert.equal(u.n, 2, 'the pre-reply report is structurally read (answering clears history)');
  const plan = db.prepare(`EXPLAIN QUERY PLAN
    WITH last_in AS (
      SELECT session_id, MAX(ts) last_ts FROM messages WHERE direction='in' GROUP BY session_id
    )
    SELECT m.session_id
    FROM messages m LEFT JOIN last_in i ON i.session_id=m.session_id
    WHERE m.direction='out' AND m.read_at IS NULL AND m.ts>COALESCE(i.last_ts,0)
    GROUP BY m.session_id`).all();
  assert(plan.some((row) => /idx_messages_in_session_ts/.test(row.detail)), 'last replies use the compact partial index');
  assert(plan.some((row) => /idx_messages_unread_out_session_ts/.test(row.detail)), 'unread reports use the compact partial index');
}

// ---- read_at column exists (additive migration) and the read UPDATE clears by ids and by session ---
{
  const rows = db.prepare("SELECT id FROM messages WHERE session_id='s_ph' AND direction='out' ORDER BY ts DESC").all();
  db.prepare('UPDATE messages SET read_at = ? WHERE id = ?').run(Date.now(), rows[0].id); // ids-mode equivalent
  assert.equal(unreadBySession().get('s_ph').n, 1, 'per-id read marking reduces unread');
  db.prepare("UPDATE messages SET read_at = ? WHERE session_id = 's_ph' AND direction = 'out' AND read_at IS NULL").run(Date.now()); // session-mode equivalent
  assert.equal(unreadBySession().get('s_ph'), undefined, 'session-mode clears the backlog');
}

// ---- the real read route emits one scoped unread patch (no broad reload required) -----------------
{
  addMessage('s_ph', 'out', 'detect', 'a new unread report for cross-client sync');
  const event = new Promise((resolve) => bus.once('session-status', resolve));
  await new Promise((r) => setTimeout(r, 30));
  const response = await fetch(`http://127.0.0.1:${port}/api/messages/read`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 's_ph' }),
  });
  assert.equal(response.status, 200);
  const patch = await Promise.race([event, new Promise((_, reject) => setTimeout(() => reject(new Error('missing scoped read event')), 1000))]);
  assert.deepEqual({ session: patch.session, unread: patch.unread, source: patch.source }, { session: 's_ph', unread: 0, source: 'read' });
}

// ---- inbox dismissal clears only the report boundary visible at click time ------------------------
{
  addMessage('s_ph', 'out', 'detect', 'current report part A');
  addMessage('s_ph', 'out', 'detect', 'current report part B');
  const boundary = db.prepare("SELECT MAX(id) id FROM messages WHERE session_id='s_ph' AND direction='out'").get().id;
  // Simulate a fresh work-status report racing the dismissal request. It must remain unread because its
  // id is newer than the card's last_key.id boundary.
  addMessage('s_ph', 'out', 'detect', 'future report after the visible boundary');
  const response = await fetch(`http://127.0.0.1:${port}/api/messages/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's_ph', through_id: boundary }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.marked, 2, 'dismissal marks every unread report through the visible boundary');
  assert.equal(result.unread, 1, 'a newer report survives and can reopen Needs you');
  assert.equal(unreadBySession().get('s_ph').n, 1);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s_ph'").get().status, 'exited', 'dismissal never mutates lifecycle status');
}

// ---- route + payload locks --------------------------------------------------------------------------
{
  const src = readFileSync(new URL('../src/phone_api.js', import.meta.url), 'utf8');
  assert.match(src, /ALTER TABLE messages ADD COLUMN read_at/, 'additive migration');
  assert.match(src, /\/api\/messages\/read/, 'read route exists');
  assert.match(src, /through_id/, 'read route supports report-bounded inbox dismissal');
  assert.match(src, /\/api\/phone\/home/, 'lean home route exists');
  assert.match(src, /bus\.emit\('session-status'/, 'read state publishes a scoped keyed patch');
  assert.match(src, /read_at IS NULL/, 'unread respects server-side read state');
  assert.match(src, /WITH last_in AS/, 'unread derives the last operator reply once per session');
  assert.doesNotMatch(src, /m\.ts > COALESCE\(\(SELECT MAX\(ts\)/, 'unread never repeats a correlated MAX query for every message');
  assert.match(src, /idx_messages_in_session_ts/, 'last replies use a compact partial index');
  assert.match(src, /idx_messages_unread_out_session_ts/, 'unread reports use a compact partial index');
  assert.match(src, /s\.project_id/, 'home rows retain their project identity for keyed project counts');
  const ph = readFileSync(new URL('../web/phone.js', import.meta.url), 'utf8');
  assert.match(ph, /fake-?field/i, 'composer is a fake pill (focus rule)');
  assert.ok(!/autofocus/i.test(ph.replace(/autoFocus="\{\{ true \}\}"/g, '')), 'nothing autofocuses');
  assert.match(ph, /stopped mid-queue: do NOT mark read/, 'read-on-completion semantics');
  assert.match(ph, /explicit/i, 'voice review requires explicit send');
  const sv = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(sv, /\/phone'\) p = '\/phone\.html'/, 'extensionless /phone serves the app');
  // Mobile-view contract (Option A): the dashboard pages default to the phone triage on a phone (opt into
  // the desktop dashboard via ?desktop=1 → aios_dash); the session page defaults to the desktop STORY view
  // at every width, with ?phone=1 opening the phone session. See web/{desktop,index,session}.html.
  for (const page of ['../web/index.html', '../web/desktop.html']) {
    assert.match(readFileSync(new URL(page, import.meta.url), 'utf8'), /aios_dash[\s\S]*?location\.replace\('phone'\)/, page + ' redirects a phone to the phone triage dashboard');
  }
  assert.match(readFileSync(new URL('../web/session.html', import.meta.url), 'utf8'), /get\('phone'\)[\s\S]*?phone#s\//, 'session.html: ?phone=1 opens the phone session, desktop story otherwise');
}

// The lean Usage projection is computed in a worker and remains callable in an isolated install.
{
  const response = await fetch(`http://127.0.0.1:${port}/api/usage/summary?range=30d`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(Number(body.totals?.sessions || 0), 0);
}

// Explicit windows inside the same five-minute interval are distinct cache entries.
{
  const bucket = Math.floor(Date.now() / 300000) * 300000;
  recordUsage({ source_id: 'explicit-a', source: 'test', ts: bucket + 10_500, total_tokens: 11 });
  recordUsage({ source_id: 'explicit-b', source: 'test', ts: bucket + 12_500, total_tokens: 29 });
  const getWindow = async (since, until) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/usage/summary?range=all&since=${since}&until=${until}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await getWindow(bucket + 10_000, bucket + 11_000);
  const second = await getWindow(bucket + 12_000, bucket + 13_000);
  assert.equal(first.totals.total_tokens, 11);
  assert.equal(second.totals.total_tokens, 29, 'an explicit window never reuses a neighboring cached report');
  assert(second.recent.every((row) => row.ts >= bucket + 12_000 && row.ts <= bucket + 13_000));
}

console.log('phone_api.test ok');
process.exit(0); // the phone_api import chain pulls in server.js (listeners + poll timers) — exit explicitly
