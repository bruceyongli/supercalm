import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-phone-'));
process.env.AIOS_PORT = String(30000 + Math.floor(Math.random() * 9000)); // phone_api pulls in server.js — keep it off the live port

const { db, addMessage } = await import('../src/store.js');
const { unreadBySession } = await import('../src/phone_api.js');

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

// ---- route + payload locks --------------------------------------------------------------------------
{
  const src = readFileSync(new URL('../src/phone_api.js', import.meta.url), 'utf8');
  assert.match(src, /ALTER TABLE messages ADD COLUMN read_at/, 'additive migration');
  assert.match(src, /\/api\/messages\/read/, 'read route exists');
  assert.match(src, /\/api\/phone\/home/, 'lean home route exists');
  assert.match(src, /read_at IS NULL/, 'unread respects server-side read state');
  const ph = readFileSync(new URL('../web/phone.js', import.meta.url), 'utf8');
  assert.match(ph, /fake-?field/i, 'composer is a fake pill (focus rule)');
  assert.ok(!/autofocus/i.test(ph.replace(/autoFocus="\{\{ true \}\}"/g, '')), 'nothing autofocuses');
  assert.match(ph, /stopped mid-queue: do NOT mark read/, 'read-on-completion semantics');
  assert.match(ph, /explicit/i, 'voice review requires explicit send');
  const sv = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(sv, /\/phone'\) p = '\/phone\.html'/, 'extensionless /phone serves the app');
  for (const page of ['../web/index.html', '../web/session.html']) {
    assert.match(readFileSync(new URL(page, import.meta.url), 'utf8'), /aios_force_desktop/, page + ' carries the guarded phone redirect');
  }
}

console.log('phone_api.test ok');
process.exit(0); // the phone_api import chain pulls in server.js (listeners + poll timers) — exit explicitly
