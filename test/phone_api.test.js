import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-phone-'));
const port = 30000 + Math.floor(Math.random() * 9000);
process.env.AIOS_PORT = String(port); // phone_api pulls in server.js — keep it off the live port

const { db, addMessage } = await import('../src/store.js');
const { unreadBySession } = await import('../src/phone_api.js');
const { bus } = await import('../src/bus.js');

// seed a session + conversation shape: out (old) -> in (reply) -> out, out (new episode)
db.prepare("INSERT INTO sessions (id, project_id, tool, tmux, status, started_at, last_activity) VALUES ('s_ph','p_ph','codex','tmx_ph','waiting', 1, 1)").run();
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

// ---- route + payload locks --------------------------------------------------------------------------
{
  const src = readFileSync(new URL('../src/phone_api.js', import.meta.url), 'utf8');
  assert.match(src, /ALTER TABLE messages ADD COLUMN read_at/, 'additive migration');
  assert.match(src, /\/api\/messages\/read/, 'read route exists');
  assert.match(src, /\/api\/phone\/home/, 'lean home route exists');
  assert.match(src, /bus\.emit\('session-status'/, 'read state publishes a scoped keyed patch');
  assert.match(src, /read_at IS NULL/, 'unread respects server-side read state');
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

console.log('phone_api.test ok');
process.exit(0); // the phone_api import chain pulls in server.js (listeners + poll timers) — exit explicitly
