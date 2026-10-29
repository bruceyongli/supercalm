import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const dir = await mkdtemp(join(tmpdir(), 'aios-family-api-'));
const probe = createServer(); await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
const port = probe.address().port; await new Promise(ok => probe.close(ok));
Object.assign(process.env, { AIOS_DATA: join(dir, 'data'), AIOS_WORKTREE_ROOT: join(dir, 'worktrees'),
  AIOS_TMUX: '/usr/bin/false', AIOS_HOST: '127.0.0.1', AIOS_PORT: String(port), AIOS_SUMMARY_PORT: '1', AIOS_DISK_RESERVE_BYTES: '1' });
delete process.env.AIOS_NO_LISTEN;
const request = async (path, body, headers = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? {} : { method:'POST', headers:{'content-type':'application/json',...headers}, body:JSON.stringify(body) });
  return { status:res.status, body:await res.json() };
};
let store;
try {
  const { featureReady } = await import('../src/server.js'); await featureReady;
  store = await import('../src/store.js');
  const projectPath = join(dir, 'project'); await mkdir(projectPath);
  store.createProject({id:'p_family', name:'Family fixture', path:projectPath});
  const fixture = (id, parent = null, at = 1) => {
    store.createSession({id, project_id:'p_family', parent_session_id:parent, tool:'codex', tmux:`fixture-${id}`, title:id, status:'exited'});
    store.updateSession(id, {last_activity:at, status_reason:'operator-kill'});
  };
  fixture('s_grandparent'); fixture('s_parent', 's_grandparent');
  for (let i = 0; i < 125; i++) fixture(`s_history_${i}`, null, 100 + i);
  fixture('s_recent_child', 's_parent', Date.now());
  const home = (await request('/api/phone/home')).body;
  assert(home.sessions.some(s => s.id === 's_parent'), 'a child cannot lose its parent outside the recent-120 boundary');
  assert(home.sessions.some(s => s.id === 's_grandparent'), 'ancestor closure includes the complete known chain');
  assert.equal(home.sessions.find(s => s.id === 's_recent_child').parent_session_id, 's_parent');
  assert.equal(store.getSession('s_parent').last_activity, 1, 'projection cannot promote parent activity');

  const task = 'Check the mobile layout.\n' + 'Keep complete instructions, constraints and evidence. '.repeat(50);
  const named = await request('/api/session/s_parent/child', {name:'手机端验收',task,tool:'codex'});
  assert.equal(named.status, 202, JSON.stringify(named.body));
  assert.equal(named.body.title, '手机端验收');
  assert.equal(named.body.parent_session_id, 's_parent');
  assert.equal(store.recentMessagesFor(named.body.id, 10).find(m => m.source === 'task').text, task, 'short name cannot truncate the work request');
  await request(`/api/session/${named.body.id}/kill`, {});
  const generic = await request('/api/session', {project_id:'p_family', tool:'codex', agent_name:'Login regression', task}, {'x-aios-parent-session':'s_parent'});
  assert.equal(generic.status, 202, JSON.stringify(generic.body));
  assert.equal(generic.body.title, 'Login regression');
  assert.equal(generic.body.parent_session_id, 's_parent');
  await request(`/api/session/${generic.body.id}/kill`, {});
  // No running native agent was ever launched: the only tmux executable in this fixture is false.
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log(JSON.stringify({handlers:['phone/home','session/:id/child','session'],parentClosure:true,shortNames:true,fullTaskPreserved:true,realAgentsStarted:0,productionTouched:false}));
} finally { store?.db.close(); await rm(dir, {recursive:true,force:true}); }
process.exit(0);
