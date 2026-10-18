import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const dir = mkdtempSync(join(tmpdir(), 'aios-liveness-'));
process.env.AIOS_DATA = join(dir, 'data'); process.env.AIOS_WORKTREE_ROOT = join(dir, 'worktrees');
process.env.LIVENESS_STATE = join(dir, 'state'); process.env.LIVENESS_TRACE = join(dir, 'trace');
process.env.AIOS_CODEX_SESSIONS_DIR = join(dir, 'rollouts'); mkdirSync(process.env.AIOS_CODEX_SESSIONS_DIR);
const fixture = fileURLToPath(new URL('fixtures/liveness_tmux.mjs', import.meta.url));
const wrapper = join(dir, 'tmux');
writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o755 });
process.env.AIOS_TMUX = wrapper; process.env.AIOS_HOST = '127.0.0.1'; process.env.AIOS_SUMMARY_PORT = '1';
const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
process.env.AIOS_PORT = String(probe.address().port); await new Promise(r => probe.close(r));
delete process.env.AIOS_NO_LISTEN;
const save = patch => writeFileSync(process.env.LIVENESS_STATE, JSON.stringify({ ...state(), ...patch }));
const state = () => JSON.parse(readFileSync(process.env.LIVENESS_STATE, 'utf8'));
writeFileSync(process.env.LIVENESS_STATE, JSON.stringify({ names: ['_aios_keep'], fail: true }));
writeFileSync(process.env.LIVENESS_TRACE, '');
const calls = () => readFileSync(process.env.LIVENESS_TRACE, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const mutations = () => calls().filter(c => ['new-session', 'kill-session', 'send-keys'].includes(c[0]) && !c.includes('_aios_keep'));
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, message, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (fn()) return; await pause(30); }
  throw new Error(message);
}
let store;
try {
  store = await import('../src/store.js');
  const { createAttentionReport, dismissAttention, getAttentionDismissal } = await import('../src/attention_store.js');
  const old = Date.now() - 86400_000;
  const ids = ['s_voice', 's_current', 's_tutoring', 's_skills'];
  for (const id of ids) {
    store.createSession({ id, tmux: id, tool: 'codex', status: 'waiting' });
    store.updateSession(id, { status: 'exited', status_reason: 'unexpected-exit', runtime_status: 'exited',
      desired_status: 'waiting', ended_at: Date.now(), last_activity: old, question: 'Review the result', summary: 'Ready for review' });
    const report = createAttentionReport(id, 'Review the result').message; dismissAttention(id, report.id);
  }
  store.createSession({ id: 's_stopped', tmux: 's_stopped', tool: 'codex', status: 'exited', desired_status: 'exited', status_reason: 'operator-stop' });
  store.createSession({ id: 's_killed', tmux: 's_killed', tool: 'codex', status: 'exited', desired_status: 'exited', status_reason: 'operator-kill' });
  store.createSession({ id: 's_shell', tmux: 's_shell', tool: 'codex', status: 'exited', desired_status: 'waiting', status_reason: 'unexpected-exit' });
  save({ names: [...state().names, ...ids, 's_stopped', 's_killed', 's_shell'], shells: ['s_shell'] });
  const { featureReady } = await import('../src/server.js'); await featureReady;
  const sessions = await import('../src/sessions.js');
  assert.equal(mutations().length, 0, 'failed boot probe cannot kill/relaunch live agents');
  for (const id of ids) assert.equal(store.getSession(id).status, 'exited', 'unknown boot observation does not rewrite DB');
  save({ fail: false });
  await until(() => ids.every(id => store.getSession(id).status === 'waiting'), 'deferred boot discovery did not retry automatically');
  for (const id of ids) {
    const s = store.getSession(id);
    assert.equal(s.status, 'waiting'); assert.equal(s.runtime_status, 'running'); assert.equal(s.ended_at, null);
    assert.equal(s.last_activity, old); assert.equal(s.question, 'Review the result');
    assert.ok(getAttentionDismissal(id));
  }
  assert.equal(mutations().length, 0, 'all four false exits reattach without restart or injected input');
  assert.equal(store.getSession('s_shell').status, 'exited', 'an empty shell is not a recovered agent');
  const base = `http://127.0.0.1:${process.env.AIOS_PORT}`;
  const post = (path, body = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  save({ fail: true });
  for (const path of ['/input', '/type', '/resume']) {
    const response = await post('/api/session/s_voice' + path, { text: 'Do not deliver during failed health check', data: 'x' });
    assert.equal(response.status, 503, path); assert.match((await response.json()).error, /health check/);
  }
  await pause(3500);
  for (const id of ids) assert.equal(store.getSession(id).status, 'waiting', 'outage cannot produce false exit');
  assert.equal(mutations().length, 0);
  save({ fail: false });
  // Direct Resume of stale Exited metadata must attach, not restart an already-running process.
  store.updateSession('s_voice', { status: 'exited', status_reason: 'unexpected-exit', ended_at: Date.now() });
  assert.equal((await post('/api/session/s_voice/resume')).status, 200);
  assert.equal(store.getSession('s_voice').status, 'waiting'); assert.equal(mutations().length, 0);
  // Runtime self-repair works too: neither a service restart nor manual Resume is necessary.
  store.updateSession('s_current', { status: 'exited', status_reason: 'unexpected-exit', ended_at: Date.now() });
  await until(() => store.getSession('s_current').status === 'waiting', 'runtime did not reattach');
  assert.equal(mutations().length, 0);
  // An intentional Stop/Kill remains authoritative even if its old pane appears in the inventory.
  assert.equal(store.getSession('s_stopped').status, 'exited'); assert.equal(store.getSession('s_killed').status, 'exited');
  store.createSession({ id: 's_missing_kill', tmux: 's_missing_kill', tool: 'codex', status: 'waiting' });
  store.updateSession('s_missing_kill', { last_activity: old - 1000 });
  const race = join(dir, 'observation');
  // Pause after discover has captured its expected-live DB rows, not before querying them.
  save({ pause: race, pauseCommand: 'display-message', pauseTarget: 's_tutoring' });
  const discovering = sessions.discover();
  await until(() => existsSync(race), 'probe did not pause');
  await sessions.killSession('s_tutoring'); await sessions.killSession('s_missing_kill');
  save({ pause: null }); await discovering;
  assert.equal(store.getSession('s_tutoring').status_reason, 'operator-kill', 'late observation cannot undo kill');
  assert.equal(store.getSession('s_missing_kill').status_reason, 'operator-kill', 'missing-pane recovery cannot undo kill');
  assert.equal(mutations().filter(c => c[0] === 'new-session').length, 0);
  // A genuinely missing pane is eventually marked exited, but its activity/dismissal stay intact.
  save({ names: state().names.filter(n => n !== 's_skills') });
  await until(() => store.getSession('s_skills').status === 'exited', 'confirmed absence did not retire session');
  assert.equal(store.getSession('s_skills').last_activity, old);
  assert.equal(store.getSession('s_skills').desired_status, 'waiting');
  assert.ok(getAttentionDismissal('s_skills'));
  console.log(JSON.stringify({ scenario: 'real HTTP lifecycle with isolated tmux', bootOutage: 'no mutation',
    falseExitsRecovered: 4, liveAgentRestarts: 0, inputDuringOutage: 503, resume: 'reattach',
    runtimeRepair: 'automatic', explicitStops: 'preserved', killRace: 'preserved', genuineAbsence: 'confirmed', liveDataTouched: false }));
} catch (error) { console.error(error); process.exitCode = 1; }
finally { store?.db.close(); rmSync(dir, { recursive: true, force: true }); }
process.exit(process.exitCode || 0);
