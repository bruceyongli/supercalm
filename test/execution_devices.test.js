import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile), dir = await mkdtemp(join(tmpdir(), 'aios-execution-test-'));
process.env.AIOS_DATA = join(dir,'controller'); process.env.AIOS_WORKTREE_ROOT = join(dir,'worktrees');
process.env.AIOS_EXECUTION_NODES_FILE = join(dir,'nodes.json'); process.env.AIOS_ENV_FILE = join(dir,'absent.env');
delete process.env.AIOS_EXECUTION_NODE;
const source = join(dir,'source'), workerRoot = join(dir,'worker'), uuid = '11111111-2222-4333-8444-555555555555';
const token = 'a'.repeat(64), sid = 's_device_fixture', op = 'x_' + 'a'.repeat(24);
let child, store, logs = '';
try {
  await mkdir(source); await mkdir(workerRoot); await mkdir(join(workerRoot,'data/logs'),{recursive:true});
  const git = async (...args) => (await exec('/usr/bin/git',['-C',source,...args])).stdout.trim();
  await git('init','-b','main'); await git('config','user.email','test@localhost'); await git('config','user.name','Device fixture');
  await writeFile(join(source,'plan.md'),'# Plan\nKeep original context.\n'); await git('add','.'); await git('commit','-m','fixture');
  await writeFile(join(source,'plan.md'),'# Plan\nStaged detail.\n'); await git('add','plan.md');
  await writeFile(join(source,'plan.md'),'# Plan\nUnstaged detail.\n'); await writeFile(join(source,'local.txt'),'untracked');
  const bundle = await import('../src/execution_bundle.js');
  const transport = await import('../src/execution_transport.js');
  assert.throws(() => bundle.safeArchiveName('../escape')); assert.throws(() => bundle.safeArchiveName('/absolute'));
  assert.equal(bundle.safeArchiveName('./good/file'),'good/file');
  assert.throws(() => transport.validateExecutionNode({id:'x',host:'bb2;touch nope'}));
  const probe = createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r)); const port = probe.address().port; await new Promise(r=>probe.close(r));
  const node = transport.validateExecutionNode({id:'fixture',host:'bb2',root:workerRoot,token,localPort:port,remotePort:port,callbackPort:18793});
  assert.ok(transport.sshArguments(node).includes('ExitOnForwardFailure=yes'));
  await transport.saveExecutionNode(node); assert.equal((await lstat(process.env.AIOS_EXECUTION_NODES_FILE)).mode & 0o777,0o600);
  await writeFile(join(workerRoot,'control-token'),token,{mode:0o600});
  const fakeTmux = join(dir,'tmux'); await writeFile(fakeTmux,'#!/bin/sh\necho "no server running on fixture" >&2\nexit 1\n',{mode:0o755});
  child = spawn(process.execPath,['src/server.js'], { cwd:resolve('.'), env: { ...process.env,
    AIOS_DATA:join(workerRoot,'data'), AIOS_EXECUTION_NODE:'fixture', AIOS_EXECUTION_ROOT:workerRoot,
    AIOS_EXECUTION_NODES_FILE:join(workerRoot,'no-nodes.json'), AIOS_PORT:String(port), AIOS_HOST:'127.0.0.1',
    AIOS_TMUX:fakeTmux, AIOS_WORKTREE_ROOT:join(workerRoot,'worktrees'),
    CODEX_HOME:join(workerRoot,'native/codex'), AIOS_CODEX_SESSIONS_DIR:join(workerRoot,'native/codex/sessions'),
    CLAUDE_CONFIG_DIR:join(workerRoot,'native/claude'), AIOS_EXECUTION_CATALOG_URL:'http://127.0.0.1:1/models',
    AIOS_EXECUTION_MODEL_URL:'http://127.0.0.1:1/model', AIOS_AUTO_PUBLISH:'0',
  }, stdio:['ignore','pipe','pipe'] });
  child.stdout.on('data',b=>logs=(logs+b).slice(-20000)); child.stderr.on('data',b=>logs=(logs+b).slice(-20000));
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for(let i=0;i<300;i++) { if(child.exitCode != null) throw Error(logs); try { if((await fetch(base+'/readyz')).ok) { ready=true;break; } } catch {} await new Promise(r=>setTimeout(r,100)); }
  assert.ok(ready,logs);
  assert.equal((await fetch(base+'/api/execution/health')).status,403);
  const request = (path, body) => transport.nodeRequest(node,path, body === undefined ? {} : {method:'POST',body,timeout:30000});
  assert.equal((await request('/api/execution/health')).node,'fixture');
  store = await import('../src/store.js');
  const state = await import('../src/execution_state.js');
  const attention = await import('../src/attention_store.js');
  store.createProject({id:'p_device_fixture',name:'Device fixture',path:source});
  store.createSession({id:sid,project_id:'p_device_fixture',tool:'codex',tmux:'fixture-source',status:'exited',autonomy:'full',model:'gpt-6.1-sol',effort:'xhigh'});
  store.updateSession(sid,{worktree_path:source,branch:'main',codex_uuid:uuid,desired_status:'exited',runtime_status:'exited',status_reason:'operator-stop'});
  store.addMessage(sid,'in','task','Keep the original task.'); store.addMessage(sid,'out','detect','Original report');
  attention.dismissAttention(sid);
  const native = join(dir,`rollout-2026-11-01T00-00-00-${uuid}.jsonl`);
  await writeFile(native,JSON.stringify({type:'session_meta',payload:{id:uuid,cwd:source,timestamp:'2026-11-01T00:00:00Z'}})+'\n');
  await bundle.assertNativeIdentity(native,'codex',uuid);
  await assert.rejects(bundle.assertNativeIdentity(native,'codex','wrong'),/different conversation/);
  const evidence = await bundle.gitEvidence(source);
  const spec = {...state.exportExecutionState(sid),kind:'move',git:evidence,native:{uuid,name:native.split('/').at(-1)},manifest:{},sourcePath:source};
  assert.equal((await request(`/api/execution/import/${op}`)).phase,'absent');
  assert.equal((await request(`/api/execution/import/${op}/prepare`,spec)).phase,'receiving');
  const parts = {};
  parts.git = await bundle.uploadExecutionPart(node,op,'git',bundle.gitBundle(source));
  parts.tree = await bundle.uploadExecutionPart(node,op,'tree',bundle.workingArchive(source));
  parts.index = await bundle.uploadExecutionPart(node,op,'index',evidence.index);
  parts.native = await bundle.uploadExecutionPart(node,op,'native',native);
  await assert.rejects(request(`/api/execution/import/${op}/finalize`,{parts:{tree:{...parts.tree,size:1}}}),/receipt mismatch/);
  const [result, same] = await Promise.all([request(`/api/execution/import/${op}/finalize`,{parts}),request(`/api/execution/import/${op}/finalize`,{parts})]);
  assert.equal(result.phase,'imported'); assert.equal(same.cwd,result.cwd);
  assert.equal((await bundle.gitEvidence(result.cwd)).statusHash,evidence.statusHash);
  assert.equal(await readFile(join(result.cwd,'local.txt'),'utf8'),'untracked');
  assert.equal(await bundle.assertLocalCheckout(result.cwd),result.cwd);
  const dormant = await request('/api/execution/state'); assert.equal(dormant.sessions.length,0,'dormant imports are invisible to reconciliation');
  store.updateSession(sid,{execution_node:'fixture'});
  assert.equal(store.listExpectedLiveSessions().length,0,'controller cannot recover worker-owned sessions');
  for(const m of result.mapping) store.db.prepare('INSERT INTO execution_message_map VALUES(?,?,?)').run('fixture',m.remote_id,m.local_id);
  const active = await request(`/api/execution/import/${op}/activate`,{});
  assert.equal(active.session.status,'exited','move stays paused'); assert.equal(active.session.codex_uuid,uuid);
  assert.equal((await request(`/api/execution/import/${op}/activate`,{})).session.id,sid,'duplicate activation is idempotent');
  const snapshot = await request('/api/execution/state'); state.mirrorExecutionSnapshot(node,snapshot);
  const before = store.getSession(sid); state.mirrorExecutionSnapshot(node,snapshot);
  assert.equal(store.getSession(sid).revision,before.revision,'polling preserves revision and activity');
  assert.equal(store.messagesFor(sid,50).length,2,'imported messages never duplicate');
  assert.ok(attention.getAttentionDismissal(sid),'dismissed report stays dismissed');
  const count = snapshot.messages.at(-1).id;
  state.mirrorExecutionSnapshot(node,{...snapshot,cursor:count+1,messages:[{...snapshot.messages.at(-1),id:count+1,text:'New update',ts:Date.now(),read_at:null}]});
  assert.equal(attention.getAttentionDismissal(sid),null,'only a genuinely new report reopens attention');
  assert.equal(await readFile(join(source,'plan.md'),'utf8'),'# Plan\nUnstaged detail.\n','original is unchanged');
  assert.equal((await bundle.gitEvidence(source)).statusHash,evidence.statusHash);
  await assert.rejects(lstat(join(workerRoot,'imports',op,'tree')),{code:'ENOENT'},'transfer containers cleaned after activation');
  console.log(JSON.stringify({pass:true,handler:'actual worker HTTP import',git:'HEAD/index/staged/unstaged/untracked preserved',native:uuid,
    owner:'fixture',paused:true,originals:'retained',duplicateImport:'idempotent',attention:'dismissal retained until new report',transport:'private token'}));
} catch(error) { console.error(logs); throw error; }
finally { if(child?.exitCode == null){child.kill('SIGTERM');await new Promise(r=>child.once('close',r));} store?.db.close(); await rm(dir,{recursive:true,force:true}); }
process.exit(0);
