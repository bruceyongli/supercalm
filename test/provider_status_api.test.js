import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const dir = await mkdtemp(join(tmpdir(), 'aios-provider-status-'));
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
Object.assign(process.env, { AIOS_DATA: join(dir, 'data'), AIOS_WORKTREE_ROOT: join(dir, 'worktrees'),
  AIOS_TMUX: '/usr/bin/false', AIOS_HOST: '127.0.0.1', AIOS_PORT: String(port), AIOS_SUMMARY_PORT: '1' });
delete process.env.AIOS_NO_LISTEN;
const request = async (path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  assert.equal(res.status, 200, path);
  return res.json();
};
let store;
try {
  const { featureReady } = await import('../src/server.js'); await featureReady;
  store = await import('../src/store.js');
  const { classify } = await import('../src/detect_classify.js');
  const { noteAgentStatus, noteReply } = await import('../src/sessions.js');
  const { bus } = await import('../src/bus.js');
  const events = []; bus.on('session-status', e => events.push(e));
  const path = join(dir, 'project'); await mkdir(path);
  store.createProject({ id: 'p_capacity', name: 'Capacity fixture', path });
  const sid = 's_capacity';
  store.createSession({ id: sid, project_id: 'p_capacity', tool: 'codex', tmux: 'fixture-capacity',
    title: 'Implement the requested update', model: 'gpt-test', status: 'waiting' });
  const before = store.getSession(sid);
  const screen = '■ Selected model is at capacity. Please try a different model.\n› my unsent draft\n? for shortcuts';
  const observe = snap => {
    const row = store.getSession(sid);
    const result = classify({ session: row, snap, idleMs: 10000 });
    // The same classifier -> durable status -> SSE path invoked by the live poller. No coding
    // process is launched, no prompt is sent, and all HTTP handlers use this isolated real database.
    return noteAgentStatus(sid, result.status, result.question, {
      source: 'poll', activityBump: false, providerIssue: result.providerIssue || null,
    });
  };
  let row = observe(screen);
  assert.equal(row.status, 'waiting'); assert.equal(row.runtime_status, 'running');
  assert.equal(row.stage, 'blocked'); assert.equal(row.category, 'action');
  assert.equal(row.last_activity, before.last_activity, 'classification does not promote an old session');
  assert.equal(row.model, before.model, 'no silent fallback');
  for (const url of ['/api/state', '/api/phone/home', `/api/session/${sid}?surface=phone`]) {
    const result = await request(url), projected = result.sessions?.find(s => s.id === sid) || result;
    assert.deepEqual(projected.provider_issue, { code: 'capacity', phase: 'blocked' }, url);
    assert.match(projected.question, /Model at capacity/);
  }
  const home = await request('/api/phone/home');
  const story = await request(`/api/session/${sid}/story`);
  assert.deepEqual(story.providerIssue, { code: 'capacity', phase: 'blocked', reportId: home.sessions[0].last_key.id }, 'Story shows a terminal-only failure without needing a native transcript record');
  assert.equal(story.pendingQuestion, null, 'a provider failure is not a question');
  assert.equal(home.counts.blocked, 1); assert.equal(home.counts.waiting, 0);
  assert.deepEqual(events.at(-1).provider_issue, { code: 'capacity', phase: 'blocked' }, 'live patch includes canonical warning');
  assert.equal(events.at(-1).source, 'poll');
  const report = home.sessions[0].last_key.id;
  const revision = row.revision;
  await request('/api/messages/read', { session_id: sid, through_id: report, dismiss: true });
  for (let i = 0; i < 4; i++) row = observe(screen);
  assert.equal(row.revision, revision, 'unchanged failure creates no write/event/animation churn');
  assert.equal((await request('/api/phone/home')).sessions[0].dismissed, true, 'cross-device dismissal stays dismissed');
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE direction='out'").get().n, 1, 'one failure episode, one report');

  observe('■ Selected model is at capacity. Please try a different model.\nRetrying in 10 seconds…\n› ');
  const retry = await request('/api/phone/home');
  assert.equal(retry.sessions[0].status, 'working');
  assert.equal(retry.sessions[0].provider_issue.phase, 'retrying');
  assert.equal(retry.counts.blocked, 0); assert.equal(retry.counts.waiting, 0);
  assert.equal(retry.sessions[0].category, null, 'automatic retry does not ask the operator a question');
  observe('• Continuing the implementation\nWorking… (2s · esc to interrupt)');
  assert.equal((await request(`/api/session/${sid}?surface=phone`)).provider_issue, null, 'actual progress clears the warning');
  assert.equal((await request(`/api/session/${sid}/story`)).providerIssue, null, 'fresh Story clears transient metadata outside its cached events');
  assert.equal(store.getSession(sid).model, 'gpt-test');
  assert.equal(store.getSession(sid).last_activity, before.last_activity);

  store.addMessage(sid, 'in', 'text', 'Retry'); noteReply(sid);
  observe(screen);
  const renewed = await request('/api/phone/home');
  assert.equal(renewed.sessions[0].dismissed, false, 'a new failure after actual operator input is a new report');
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE direction='in'").get().n, 1, 'no generated retries or duplicate sends');
  const again = store.getSession(sid);
  noteAgentStatus(sid, 'waiting', 'Allow access to the requested file?', { source: 'hook', activityBump: false });
  assert.equal(store.getSession(sid).provider_issue, null, 'a fresh native question supersedes an old capacity warning');
  assert.equal(store.getSession(sid).question, 'Allow access to the requested file?');
  store.updateSession(sid, { status: 'starting' });
  assert.equal(store.getSession(sid).provider_issue, null, 'relaunch clears old failure metadata');
  console.log(JSON.stringify({ trace: 'classifier -> noteAgentStatus/applyStatus -> SQLite -> session-status SSE payload -> real HTTP state/home/detail',
    warning: 'capacity/blocked', process: again.runtime_status, modelUnchanged: again.model === before.model,
    repeatedFailure: 'one report', dismissal: 'preserved', autoRetry: 'working/retrying', recovered: 'cleared', liveDataTouched: false }));
} finally {
  store?.db.close(); await rm(dir, { recursive: true, force: true });
}
process.exit(0);
