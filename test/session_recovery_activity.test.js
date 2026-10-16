import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeWorkTimestamp, nativeWorkActivity, restoringWaiting } from '../src/session_recovery_activity.js';
import { observeMonitorSnapshot } from '../src/session_monitor_state.js';
import { repairRebootRecency } from '../src/session_recency_repair.js';
import { DatabaseSync } from 'node:sqlite';

const now = Date.now(), old = now - 30 * 86400_000, boot = now - 60_000;
const codex = { tool: 'codex', codex_uuid: '11111111-2222-3333-4444-555555555555' };
const row = (type, ts, payload) => ({ type, timestamp: new Date(ts).toISOString(), payload });
const work = ts => row('event_msg', ts, { type: 'agent_message', message: '修复完成。' });
assert.equal(nativeWorkTimestamp(work(old), codex), old);
for (const item of [row('session_meta', now, {}), row('turn_context', now, {}),
  row('event_msg', now, { type: 'token_count' }), row('response_item', now, { type: 'message', role: 'developer' })]) {
  assert.equal(nativeWorkTimestamp(item, codex), 0, 'startup, context and usage metadata are not work');
}
assert.equal(nativeWorkTimestamp(work(now + 120_000), codex), 0, 'invalid future timestamps cannot unlock restoration');
const session = { ...codex, status: 'waiting', last_activity: old };
const entry = { restoredWaitingSince: boot, lastChange: old, lastHash: null };
for (const frame of ['Loading conversation…', 'Meet the latest model', 'Ready', 'Tip updated']) {
  const prior = entry.lastChange;
  let changed = observeMonitorSnapshot(entry, frame, session.status);
  if (restoringWaiting(entry, session, old)) { changed = false; entry.lastChange = prior; }
  assert.equal(changed, false); assert.equal(entry.lastChange, old);
}
assert.equal(restoringWaiting(entry, session, boot - 1000), false, 'new work during service downtime unlocks too');
assert.equal(entry.restoredWaitingSince, undefined);
assert.equal(restoringWaiting({ restoredWaitingSince: boot }, { ...session, last_activity: now }), false, 'direct input unlocks');
assert.equal(restoringWaiting({ restoredWaitingSince: boot }, { ...session, status: 'working' }), false, 'reply/hooks unlock');

const scratch = await mkdtemp(join(tmpdir(), 'aios-reboot-recency-'));
try {
  const file = join(scratch, 'bound.jsonl');
  await writeFile(file, JSON.stringify(work(old)) + '\n' + JSON.stringify(row('session_meta', now, {})) + '\n');
  assert.deepEqual(await nativeWorkActivity(codex, { file }), { available: true, lastAt: old });
  await appendFile(file, JSON.stringify(work(now))); // incomplete trailing record
  assert.equal((await nativeWorkActivity(codex, { file })).lastAt, old);
  await appendFile(file, '\n');
  assert.equal((await nativeWorkActivity(codex, { file })).lastAt, now);
  await writeFile(file, 'x'.repeat(300_000) + '\n' + JSON.stringify(work(old)) + '\n');
  assert.equal((await nativeWorkActivity(codex, { file })).lastAt, old, 'bounded tail skips partial records and keeps UTF-8');
  assert.deepEqual(await nativeWorkActivity({ tool: 'codex', project_id: 'same-cwd' }), { available: false, lastAt: 0 }, 'no sibling lookup');
  const native = codex.codex_uuid, claude = { tool: 'claude', claude_transcript: join(scratch, `${native}.jsonl`) };
  const claudeRow = { type: 'assistant', timestamp: new Date(old).toISOString(), sessionId: native,
    message: { content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' } };
  assert.equal(nativeWorkTimestamp(claudeRow, claude), old);
  assert.equal(nativeWorkTimestamp({ ...claudeRow, isSidechain: true }, claude), 0);
  assert.equal(nativeWorkTimestamp({ ...claudeRow, sessionId: 'another-session' }, claude), 0);

  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, tool TEXT, status TEXT, last_activity INTEGER, started_at INTEGER, revision INTEGER);
    CREATE TABLE events(id INTEGER PRIMARY KEY, session_id TEXT, ts INTEGER, type TEXT, payload TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, ts INTEGER, direction TEXT, read_at INTEGER);
    CREATE TABLE attention_dismissals(session_id TEXT, report_id INTEGER);`);
  const event = (id, ts, type, payload = {}) => db.prepare('INSERT INTO events(session_id,ts,type,payload) VALUES (?,?,?,?)').run(id, ts, type, JSON.stringify(payload));
  const create = (id, options = {}) => {
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(id, 'codex', 'waiting', boot + 1000, old - 1000, 1);
    event(id, old, 'status', { from: 'working', to: 'waiting' });
    event(id, boot, 'boot-recovery-start', { desired_status: 'waiting', ...options });
    event(id, boot + 500, 'resume', { reason: 'boot-recovery' });
    event(id, boot + 600, 'hook', { event: 'SessionStart' });
  };
  for (const id of ['idle', 'checkpoint', 'native', 'input', 'intent', 'hook', 'key', 'stop', 'unknown', 'error', 'working', 'late', 'race']) create(id);
  db.prepare("UPDATE events SET payload=? WHERE session_id='checkpoint' AND type='boot-recovery-start'").run(JSON.stringify({ desired_status: 'waiting', previous_last_activity: old + 100 }));
  db.prepare("UPDATE events SET payload=? WHERE session_id='working' AND type='boot-recovery-start'").run(JSON.stringify({ desired_status: 'working' }));
  db.prepare("UPDATE sessions SET last_activity=? WHERE id='late'").run(boot + 120001);
  db.prepare('INSERT INTO messages(session_id,ts,direction,read_at) VALUES (?,?,?,?)').run('input', boot + 1, 'in', null);
  db.prepare('INSERT INTO messages(session_id,ts,direction,read_at) VALUES (?,?,?,?)').run('idle', boot + 5000, 'out', boot + 6000);
  db.prepare('INSERT INTO attention_dismissals VALUES (?,?)').run('idle', 2);
  event('intent', boot + 1, 'resume', { reason: 'model-change' });
  event('hook', boot + 1, 'hook', { event: 'UserPromptSubmit' });
  event('key', boot + 1, 'terminal-input', { after_restore: true });
  event('stop', boot + 1, 'stop');
  const evidence = async s => {
    if (s.id === 'error') throw new Error('unreadable');
    return { available: ['native', 'unknown'].includes(s.id), lastAt: s.id === 'native' ? boot + 1 : 0 };
  };
  const before = db.prepare('SELECT * FROM sessions').all();
  const dry = await repairRebootRecency(db, { dryRun: true, nativeActivity: evidence, at: now });
  assert.deepEqual(dry.map(s => s.id), ['idle', 'checkpoint', 'race']);
  assert.deepEqual(db.prepare('SELECT * FROM sessions').all(), before, 'dry-run does not mutate');
  const repaired = await repairRebootRecency(db, { nativeActivity: async s => {
    if (s.id === 'race') {
      db.prepare('UPDATE sessions SET last_activity=? WHERE id=?').run(now, s.id);
      event(s.id, now, 'input');
    }
    return evidence(s);
  }, at: now });
  assert.deepEqual(repaired.map(s => s.id), ['idle', 'checkpoint']);
  assert.equal(db.prepare("SELECT last_activity FROM sessions WHERE id='idle'").get().last_activity, old);
  assert.equal(db.prepare("SELECT last_activity FROM sessions WHERE id='checkpoint'").get().last_activity, old + 100);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='idle'").get().status, 'waiting');
  assert.equal(db.prepare("SELECT read_at FROM messages WHERE session_id='idle'").get().read_at, boot + 6000);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM attention_dismissals').get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type='reboot-recency-repaired'").get().n, 2);
  assert.deepEqual(await repairRebootRecency(db, { nativeActivity: evidence }), [], 'repair is idempotent and cannot overwrite raced activity');
  db.close();
} finally { await rm(scratch, { recursive: true, force: true }); }
console.log('session_recovery_activity: native evidence, repeated startup frames, downtime work, safe/idempotent clock repair, input race and dismissal preservation passed');
