import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { splitSessionRecency } from '../web/session-recency.js';

const scratch = mkdtempSync(join(tmpdir(), 'aios-claude-monitor-'));
const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
const socket = `aios-claude-monitor-${process.pid}`;
const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const wrapper = join(scratch, 'tmux.sh');
writeFileSync(wrapper, `#!/bin/sh\nTMUX='' exec ${quote(realTmux)} -L ${quote(socket)} "$@"\n`, { mode: 0o755 });
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
process.env.AIOS_DATA = join(scratch, 'data');
process.env.AIOS_TMUX = wrapper;
process.env.AIOS_HOST = '127.0.0.1';
process.env.AIOS_PORT = String(port);
process.env.AIOS_SUMMARY_PORT = '1';
process.env.AIOS_USAGE_QUOTA_CACHE_MS = '3600000';
delete process.env.AIOS_NO_LISTEN;
const base = `http://127.0.0.1:${port}`;
const id = 's_claude_idle_fixture', native = '11111111-2222-3333-4444-555555555555';
const file = join(scratch, `${native}.jsonl`), old = Date.now() - 18 * 86400_000;
const record = (uuid, ts, content, reason, type = 'assistant') => JSON.stringify({
  type, uuid, timestamp: new Date(ts).toISOString(), sessionId: native,
  message: { id: uuid, content: [{ type: 'text', text: content }], stop_reason: reason },
}) + '\n';
let store, cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  spawnSync(realTmux, ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 3000 });
  try { store?.db.close(); } catch {}
  rmSync(scratch, { recursive: true, force: true });
}
process.once('exit', cleanup);
process.once('SIGTERM', () => { cleanup(); process.exit(143); });
process.once('SIGINT', () => { cleanup(); process.exit(130); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(100); }
  throw new Error(message);
}
try {
  mkdirSync(process.env.AIOS_DATA, { recursive: true });
  writeFileSync(file, record('old-report', old, 'The docs endpoint is ready.', 'end_turn'));
  await new Promise((resolve, reject) => {
    const child = spawn(wrapper, ['new-session', '-d', '-s', id, '-x', '100', '-y', '30',
      process.execPath, fileURLToPath(new URL('./fixtures/claude_idle_tui.mjs', import.meta.url))], { stdio: 'ignore' });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`tmux ${code}`)));
  });
  store = await import('../src/store.js');
  store.createSession({ id, tool: 'claude', tmux: id });
  store.updateSession(id, { status: 'waiting', claude_transcript: file, started_at: old - 1000, last_activity: Date.now() });
  const { createAttentionReport, dismissAttention, getAttentionDismissal } = await import('../src/attention_store.js');
  const out = createAttentionReport(id, 'Cropped legacy report.').message;
  dismissAttention(id, out.id);
  const { featureReady } = await import('../src/server.js');
  await featureReady;
  await until(() => store.getSession(id).last_activity === old, 'native work clock was not repaired');
  await pause(7000); // several REAL poll ticks across >20 native TUI repaints
  assert.equal(store.getSession(id).status, 'waiting');
  assert.equal(store.getSession(id).last_activity, old);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM events WHERE session_id=? AND type='status'").get(id).n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE session_id=? AND direction='out'").get(id).n, 1);
  assert.equal(getAttentionDismissal(id).report_id, out.id);
  let home = await (await fetch(`${base}/api/phone/home`)).json();
  let card = home.sessions.find(session => session.id === id);
  assert.equal(card.unread, 0);
  assert.equal(splitSessionRecency([card]).older.length, 1, 'both home queues retain the real old activity clock');
  const requestAt = Date.now();
  appendFileSync(file, record('new-request', requestAt, 'Check the new endpoint.', '', 'user')
    + record('new-commentary', requestAt + 1, 'Checking it now.', 'tool_use'));
  await until(() => store.getSession(id).status === 'working', 'new native request did not reach working');
  await pause(6500);
  assert.equal(store.getSession(id).status, 'working', 'a stale done line cannot stop a genuinely new quiet turn');
  appendFileSync(file, record('new-report', Date.now(), 'The NEW endpoint now works; no further action is required.', 'end_turn'));
  await until(() => store.getSession(id).status === 'waiting'
    && store.db.prepare("SELECT COUNT(*) n FROM messages WHERE session_id=? AND direction='out'").get(id).n === 2,
  'fresh source report did not create one new attention episode');
  assert.equal(getAttentionDismissal(id), null);
  home = await (await fetch(`${base}/api/phone/home`)).json();
  card = home.sessions.find(session => session.id === id);
  assert.equal(card.unread, 1);
  assert.match(card.question, /NEW endpoint now works/);
  assert.doesNotMatch(card.question, /Auto-updating|commit this|bypass permissions|Cropped legacy/);
  const latest = store.db.prepare("SELECT id,text FROM messages WHERE session_id=? AND direction='out' ORDER BY id DESC LIMIT 1").get(id);
  dismissAttention(id, latest.id);
  await pause(4000);
  assert.equal(getAttentionDismissal(id).report_id, latest.id);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE session_id=? AND direction='out'").get(id).n, 2);
  console.log(JSON.stringify({ handler: 'real session poll → classify → attention store → GET /api/phone/home',
    maintenanceRepaints: '>20', falseStatusTransitions: 0, legacyClock: 'repaired from native record',
    dismissal: 'retained across repaints', newRequest: 'working including quiet phase', newReport: 'one source-grounded unread',
    realReport: latest.text, noLiveSessionsTouched: true }));
  cleanup(); process.exit(0);
} catch (error) { console.error(error.stack || error); cleanup(); process.exit(1); }
