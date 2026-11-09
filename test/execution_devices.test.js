import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm, lstat, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import http from 'node:http';

const exec = promisify(execFile), dir = await realpath(await mkdtemp(join(tmpdir(), 'aios-execution-test-')));
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
  await writeFile(join(source,'.gitignore'),'node_modules/\n');
  await writeFile(join(source,'plan.md'),'# Plan\nKeep original context.\n'); await git('add','.'); await git('commit','-m','fixture');
  await writeFile(join(source,'plan.md'),'# Plan\nStaged detail.\n'); await git('add','plan.md');
  await writeFile(join(source,'plan.md'),'# Plan\nUnstaged detail.\n'); await writeFile(join(source,'local.txt'),'untracked');
  const smallFiles = join(source,'parallel-files'); await mkdir(smallFiles);
  for(let i=0;i<48;i++) await writeFile(join(smallFiles,`文件-${i}.txt`),Buffer.alloc(4096,i));
  await writeFile(join(smallFiles,'large.bin'),Buffer.alloc(3*1024*1024,193));
  await writeFile(join(smallFiles,'executable'),'#!/bin/sh\nexit 0\n',{mode:0o751});
  await symlink('../plan.md',join(smallFiles,'relative-link'));
  const bundle = await import('../src/execution_bundle.js');
  const {portableWorkingArchive} = await import('../src/execution_tree.js');
  const modules = join(process.env.AIOS_DATA,'session-storage',sid,'modules'); await mkdir(modules,{recursive:true});
  await writeFile(join(modules,'dependency.js'),'export const retained = true;');
  await symlink(modules,join(source,'node_modules'));
  const transport = await import('../src/execution_transport.js');
  const { initializeExecutionNative } = await import('../src/execution_native.js');
  await initializeExecutionNative(workerRoot);
  const prefs = join(workerRoot, 'native/claude/.claude.json');
  assert.deepEqual(JSON.parse(await readFile(prefs,'utf8')), {hasCompletedOnboarding:true,theme:'dark'});
  await writeFile(prefs, '{"theme":"light","custom":"retained"}');
  await initializeExecutionNative(workerRoot);
  assert.equal(await readFile(prefs,'utf8'), '{"theme":"light","custom":"retained"}', 'installer preserves existing native config');
  assert.throws(() => bundle.safeArchiveName('../escape')); assert.throws(() => bundle.safeArchiveName('/absolute'));
  assert.equal(bundle.safeArchiveName('./good/file'),'good/file');
  const unsafe = join(dir,'unsafe'); await mkdir(unsafe);
  await symlink('/outside-this-checkout',join(unsafe,'external'));
  await exec('/usr/bin/tar',['--no-mac-metadata','-cf',join(dir,'unsafe.tar'),'-C',unsafe,'.']);
  await assert.rejects(bundle.validateArchive(join(dir,'unsafe.tar')),/External symlink dependency/);
  await rm(join(unsafe,'external')); await mkdir(join(unsafe,'.git'));
  await writeFile(join(unsafe,'.git','config'),'[core]\n');
  await exec('/usr/bin/tar',['--no-mac-metadata','-cf',join(dir,'unsafe.tar'),'-C',unsafe,'.']);
  await assert.rejects(bundle.validateArchive(join(dir,'unsafe.tar')),/Git pointers are not working files/);
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
  store.db.exec('CREATE TABLE IF NOT EXISTS release_targets(project_id TEXT PRIMARY KEY,source_dir TEXT,source_branch TEXT,auto_release INTEGER,release_scripts TEXT)');
  store.db.prepare('INSERT INTO release_targets VALUES(?,?,?,?,?)').run('p_device_fixture',source,'main',1,'["bin/release"]');
  store.createSession({id:sid,project_id:'p_device_fixture',tool:'codex',tmux:'fixture-source',status:'exited',autonomy:'full',model:'gpt-6.1-sol',effort:'xhigh'});
  store.updateSession(sid,{worktree_path:source,branch:'old-registration',codex_uuid:uuid,desired_status:'exited',runtime_status:'exited',status_reason:'operator-stop'});
  store.addMessage(sid,'in','task','Keep the original task.'); store.addMessage(sid,'out','detect','Original report');
  attention.dismissAttention(sid);
  const native = join(dir,`rollout-2026-11-01T00-00-00-${uuid}.jsonl`);
  await writeFile(native,JSON.stringify({type:'session_meta',payload:{id:uuid,cwd:source,timestamp:'2026-11-01T00:00:00Z'}})+'\n');
  await bundle.assertNativeIdentity(native,'codex',uuid);
  await assert.rejects(bundle.assertNativeIdentity(native,'codex','wrong'),/different conversation/);
  const evidence = await bundle.gitEvidence(source);
  const spec = {...state.exportExecutionState(sid),kind:'move',git:evidence,native:{uuid,name:native.split('/').at(-1)},manifest:{},sourcePath:source};
  assert.equal(spec.projectTables.release_targets[0].source_dir,source);
  assert.equal((await request(`/api/execution/import/${op}`)).phase,'absent');
  assert.equal((await request(`/api/execution/import/${op}/prepare`,spec)).phase,'receiving');
  await assert.rejects(request(`/api/execution/import/${op}/prepare`,{...spec,git:{...spec.git,head:'f'.repeat(40)}}),/identity conflict/);
  assert.equal((await request(`/api/execution/import/${op}/prepare`,{...spec,migrationVersion:1})).phase,'receiving', 'an exact old operation upgrades in place');
  const parts = {};
  parts.git = await bundle.uploadExecutionPart(node,op,'git',bundle.gitBundle(source));
  parts.tree = await bundle.uploadExecutionPart(node,op,'tree',await portableWorkingArchive(source,sid));
  parts.index = await bundle.uploadExecutionPart(node,op,'index',evidence.index);
  parts.native = await bundle.uploadExecutionPart(node,op,'native',native);
  await assert.rejects(request(`/api/execution/import/${op}/finalize`,{parts:{tree:{...parts.tree,size:1}}}),/receipt mismatch/);
  const [result, same] = await Promise.all([request(`/api/execution/import/${op}/finalize`,{parts}),request(`/api/execution/import/${op}/finalize`,{parts})]);
  assert.equal(result.phase,'imported'); assert.equal(same.cwd,result.cwd);
  assert.equal((await bundle.gitEvidence(result.cwd)).statusHash,evidence.statusHash);
  assert.deepEqual((await bundle.gitEvidence(result.cwd)).identity,evidence.identity,'Git author identity retained per repository');
  assert.equal(await readFile(join(result.cwd,'local.txt'),'utf8'),'untracked');
  for(let i=0;i<48;i++) assert.deepEqual(await readFile(join(result.cwd,'parallel-files',`文件-${i}.txt`)),Buffer.alloc(4096,i));
  assert.deepEqual(await readFile(join(result.cwd,'parallel-files/large.bin')),Buffer.alloc(3*1024*1024,193),'large files stream outside the bounded small-file buffers');
  assert.equal((await lstat(join(result.cwd,'parallel-files/executable'))).mode&0o777,0o751);
  assert.equal(await readFile(join(result.cwd,'parallel-files/relative-link'),'utf8'),'# Plan\nUnstaged detail.\n');
  assert.equal(await readFile(join(result.cwd,'node_modules/dependency.js'),'utf8'),'export const retained = true;', 'owned dependencies are local, not pointers back to Spark');
  assert.equal((await exec('/usr/bin/git', ['-C', result.cwd, 'show', ':plan.md'])).stdout, '# Plan\nStaged detail.\n', 'index-only blobs are included, not just index metadata');
  assert.equal(await bundle.assertLocalCheckout(result.cwd),result.cwd);
  const dormant = await request('/api/execution/state'); assert.equal(dormant.sessions.length,0,'dormant imports are invisible to reconciliation');
  store.updateSession(sid,{execution_node:'fixture'});
  assert.equal(store.listExpectedLiveSessions().length,0,'controller cannot recover worker-owned sessions');
  for(const m of result.mapping) store.db.prepare('INSERT INTO execution_message_map VALUES(?,?,?)').run('fixture',m.remote_id,m.local_id);
  const active = await request(`/api/execution/import/${op}/activate`,{});
  const release = (await request(`/api/session/${sid}/release-context`)).context;
  assert.equal(release.source_dir,source,'release source is preserved, never redirected to worker checkout');
  assert.equal(release.auto_release,true); assert.deepEqual(release.release_scripts,['bin/release']);
  assert.equal(active.session.status,'exited','move stays paused'); assert.equal(active.session.codex_uuid,uuid);
  assert.equal(active.session.branch,'main','observed branch wins over stale registration without switching source branches');
  assert.equal((await request(`/api/execution/import/${op}/activate`,{})).session.id,sid,'duplicate activation is idempotent');
  // Legacy interrupted producers could leave a receiver-only, empty Git receipt.
  // All private record edits below are confined to this disposable worker fixture.
  const repairSid = 's_device_git_repair', repairOp = 'x_' + 'd'.repeat(24);
  const repairUuid = '44444444-2222-4333-8444-555555555555';
  store.createSession({id:repairSid,project_id:'p_device_fixture',tool:'codex',tmux:'fixture-repair',status:'exited'});
  store.updateSession(repairSid,{worktree_path:source,codex_uuid:repairUuid});
  const repairNative = join(dir,`rollout-2026-11-01T00-00-00-${repairUuid}.jsonl`);
  await writeFile(repairNative,JSON.stringify({type:'session_meta',payload:{id:repairUuid,cwd:source,timestamp:'2026-11-01T00:00:00Z'}})+'\n');
  const repairSpec = {...state.exportExecutionState(repairSid),kind:'move',git:evidence,gitSeedSession:sid,
    native:{uuid:repairUuid,name:repairNative.split('/').at(-1)},manifest:{},sourcePath:source};
  const repairPrepared = await request(`/api/execution/import/${repairOp}/prepare`,repairSpec);
  const repairDirectory = join(workerRoot,'imports',repairOp), repairRecordFile = join(repairDirectory,'record.json');
  const readRepair = async () => JSON.parse(await readFile(repairRecordFile,'utf8'));
  const putGit = bytes => fetch(`${base}/api/execution/import/${repairOp}/git`,{
    method:'PUT',headers:{'x-aios-node-token':token},body:bytes,signal:AbortSignal.timeout(10000)});
  for (const invalid of ['', 'not a Git bundle'.repeat(4)]) {
    const rejected = await putGit(invalid);
    assert.equal(rejected.status,409); assert.match((await rejected.json()).error,/Invalid Git bundle/);
    assert.ok(!(await readRepair()).parts.git,'empty/malformed upload is never acknowledged as a Git receipt');
    assert.equal((await readRepair()).phase,'receiving');
  }
  const repairParts = {
    index:await bundle.uploadExecutionPart(node,repairOp,'index',evidence.index),
    tree:await bundle.uploadExecutionPart(node,repairOp,'tree',await portableWorkingArchive(source,sid)),
    native:await bundle.uploadExecutionPart(node,repairOp,'native',repairNative),
  };
  for (const version of [2,3]) {
    // Header validation is bounded, not a pack-integrity proof. This receipt
    // remains unacknowledged by the controller and must never shortcut git-seed.
    const truncated = `# v${version} git bundle\n${'f'.repeat(40)} HEAD\n\nPACK`;
    const incoming = await putGit(truncated);
    assert.equal(incoming.status,200,'both supported Git bundle headers are accepted');
    const incomingReceipt = await incoming.json();
    assert.ok(!(await readRepair()).gitSeedReceipt,'uploads clear any previous local-generation proof');
    const generated = await request(`/api/execution/import/${repairOp}/git-seed`,{});
    assert.notEqual(generated.receipt.sha256,incomingReceipt.sha256,'receiver-only plausible but truncated bundle regenerates locally');
    assert.ok(generated.receipt.size > Buffer.byteLength(truncated));
    assert.deepEqual((await readRepair()).gitSeedReceipt,generated.receipt);
    assert.equal((await readRepair()).gitSeedSession,sid);
    const generatedInode = (await lstat(join(repairDirectory,'git'))).ino;
    assert.deepEqual((await request(`/api/execution/import/${repairOp}/git-seed`,{})).receipt,generated.receipt);
    assert.equal((await lstat(join(repairDirectory,'git'))).ino,generatedInode,'a validated successful local seed receipt is reusable');
  }
  const emptyReceipt = {size:0,sha256:createHash('sha256').digest('hex')};
  const legacy = await readRepair();
  legacy.parts.git = emptyReceipt; delete legacy.gitSeedSession; delete legacy.gitSeedReceipt;
  await writeFile(join(repairDirectory,'git'),''); await writeFile(repairRecordFile,JSON.stringify(legacy));
  await assert.rejects(request(`/api/execution/import/${repairOp}/finalize`,{parts:{...repairParts,git:emptyReceipt}}),/Invalid Git bundle/);
  assert.equal((await readRepair()).phase,'receiving','invalid Git is rejected before the unpacking phase mutation');
  await assert.rejects(lstat(repairPrepared.cwd),{code:'ENOENT'},'invalid Git cannot create a destination checkout');
  await assert.rejects(request(`/api/execution/import/${repairOp}/prepare`,{...repairSpec,native:{...repairSpec.native,uuid}}),/identity conflict/);
  assert.deepEqual((await readRepair()).parts.git,emptyReceipt,'different captured native identity cannot repair an operation');
  let finishUpload;
  const receivingLog = new Promise((resolveUpload,reject) => {
    finishUpload = http.request({hostname:'127.0.0.1',port,method:'PUT',path:`/api/execution/import/${repairOp}/log`,
      headers:{'x-aios-node-token':token}},response => {
      let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>response.statusCode===200?resolveUpload(JSON.parse(body)):reject(Error(body)));
    });
    finishUpload.on('error',reject);finishUpload.write('Retained diagnostic log');
  });
  try {
    let opened=false;
    for(let i=0;i<100;i++) {try {await lstat(join(repairDirectory,'log.partial'));opened=true;break;}catch{} await new Promise(r=>setTimeout(r,10));}
    assert.ok(opened,'the fixture upload is actively held open');
    await assert.rejects(request(`/api/execution/import/${repairOp}/prepare`,repairSpec),/busy/);
    assert.deepEqual((await readRepair()).parts.git,emptyReceipt,'repair cannot race an active receiver');
  } finally {finishUpload.end();}
  repairParts.log = await receivingLog;
  const receivingRepaired = await request(`/api/execution/import/${repairOp}/prepare`,repairSpec);
  assert.equal(receivingRepaired.phase,'receiving');assert.ok(!receivingRepaired.parts.git);
  assert.deepEqual(receivingRepaired.parts,repairParts,'repair keeps tree, native, index and diagnostic receipts');
  assert.equal((await lstat(join(repairDirectory,'git'))).size,0,'repair does not delete original or staged directories/files');
  const unpackingLegacy = await readRepair();
  unpackingLegacy.phase='unpacking';unpackingLegacy.parts.git=emptyReceipt;
  await exec('/usr/bin/git',['init','-b','main',repairPrepared.cwd]);
  const retainedMarker = join(repairPrepared.cwd,'.git','retained-diagnostic');
  await writeFile(retainedMarker,'preserve this already initialized checkout');
  await writeFile(repairRecordFile,JSON.stringify(unpackingLegacy));
  const unpackingRepaired = await request(`/api/execution/import/${repairOp}/prepare`,repairSpec);
  assert.equal(unpackingRepaired.phase,'receiving');assert.ok(!unpackingRepaired.parts.git);
  assert.equal(unpackingRepaired.cwd,repairPrepared.cwd,'same operation keeps its exact checkout');
  assert.deepEqual(unpackingRepaired.parts,repairParts);
  repairParts.git=(await request(`/api/execution/import/${repairOp}/git-seed`,{})).receipt;
  const validUnpacking = await readRepair();validUnpacking.phase='unpacking';
  await writeFile(repairRecordFile,JSON.stringify(validUnpacking));
  assert.equal((await request(`/api/execution/import/${repairOp}/prepare`,repairSpec)).phase,'unpacking','valid Git never rolls an operation back');
  await request(`/api/execution/import/${repairOp}/finalize`,{parts:repairParts});
  assert.equal(await readFile(retainedMarker,'utf8'),'preserve this already initialized checkout');
  const importedRepair = await readRepair(), importedBundle = await readFile(join(repairDirectory,'git'));
  await writeFile(join(repairDirectory,'git'),'');
  await writeFile(repairRecordFile,JSON.stringify({...importedRepair,phase:'unpacking',parts:{...importedRepair.parts,git:emptyReceipt}}));
  await assert.rejects(request(`/api/execution/import/${repairOp}/prepare`,repairSpec),/Invalid Git bundle/);
  assert.equal((await readRepair()).phase,'unpacking','an imported session prevents legacy repair');
  await writeFile(join(repairDirectory,'git'),importedBundle);await writeFile(repairRecordFile,JSON.stringify(importedRepair));
  const repairedActive = await request(`/api/execution/import/${repairOp}/activate`,{});
  assert.equal(repairedActive.session.id,repairSid);assert.equal(repairedActive.session.codex_uuid,repairUuid);
  assert.equal(repairedActive.session.execution_transfer,repairOp);assert.equal(repairedActive.session.worktree_path,repairPrepared.cwd);
  assert.equal((await bundle.gitEvidence(source)).statusHash,evidence.statusHash,'repair never changes original Git/worktree files');
  const reuseSid = 's_device_reuse', reuseOp = 'x_' + 'c'.repeat(24);
  store.createSession({id:reuseSid,project_id:'p_device_fixture',tool:'codex',tmux:'fixture-reuse',status:'exited'});
  const reuseSpec = {...state.exportExecutionState(reuseSid),kind:'move',git:{...evidence,indexReceipt:await bundle.hashFile(evidence.index)},
    archive:{sourceRoot:source},historyOnly:true,manifest:{},artifactArchives:[{sessionId:reuseSid,name:'old-report'}]};
  await request(`/api/execution/import/${reuseOp}/prepare`,reuseSpec);
  const reuseParts = {index:await bundle.uploadExecutionPart(node,reuseOp,'index',evidence.index)};
  await request(`/api/execution/import/${reuseOp}/prepare`,{...reuseSpec,gitSeedSession:sid});
  const reused = await request(`/api/execution/import/${reuseOp}/git-seed`,{});
  assert.ok(reused.receipt?.size,'an existing transfer can reuse a later same-project import without source network traversal');
  reuseParts.git = reused.receipt;
  const coldFiles = {version:1,rebuildDependencies:true,entries:[]};
  const coldSpec = {...reuseSpec,gitSeedSession:sid,coldFiles,workingStatusHash:evidence.statusHash,
    artifactCopyPolicy:{version:1,rebuildDependencies:true,source,originalsRetained:true}};
  await bundle.uploadExecutionPart(node,reuseOp,'tree',await portableWorkingArchive(source,sid));
  await bundle.uploadExecutionPart(node,reuseOp,'artifacts',await portableWorkingArchive(source,sid));
  const upgrade = await request(`/api/execution/import/${reuseOp}/prepare`,coldSpec);
  assert.ok(!upgrade.parts.tree,'an explicit cold-policy upgrade invalidates only the old staged tree');
  assert.ok(!upgrade.parts.artifacts,'an artifact policy upgrade invalidates its previous staged archive');
  assert.equal(upgrade.parts.git.sha256,reused.receipt.sha256,'already uploaded Git is reused');
  await request(`/api/execution/import/${reuseOp}/prepare`,{...coldSpec,artifactCopyPolicy:{...coldSpec.artifactCopyPolicy,version:2}});
  await assert.rejects(request(`/api/execution/import/${reuseOp}/prepare`,coldSpec),/Artifact copy policy conflict/);
  reuseParts.tree = await bundle.uploadExecutionPart(node,reuseOp,'tree',await portableWorkingArchive(source,sid,coldFiles));
  await bundle.uploadExecutionPart(node,reuseOp,'artifacts',await portableWorkingArchive(source,sid,coldFiles));
  await bundle.uploadExecutionPart(node,reuseOp,'artifact-0',await portableWorkingArchive(source,sid));
  await bundle.uploadExecutionPart(node,reuseOp,'attachments',await portableWorkingArchive(source,sid));
  const reportSpec = {...coldSpec,artifactCopyPolicy:{...coldSpec.artifactCopyPolicy,version:3,retainHistoricalArtifacts:true}};
  const reportsUpgrade = await request(`/api/execution/import/${reuseOp}/prepare`,reportSpec);
  for (const part of ['artifacts','artifact-0','attachments']) assert.ok(!reportsUpgrade.parts[part],'only historical attachment receipts invalidate');
  assert.equal(reportsUpgrade.parts.tree.sha256,reuseParts.tree.sha256,'hot code is not retransferred');
  assert.equal(reportsUpgrade.parts.git.sha256,reuseParts.git.sha256,'Git is not retransferred');
  await assert.rejects(request(`/api/execution/import/${reuseOp}/prepare`,coldSpec),/Artifact copy policy conflict/);
  reuseParts.artifacts = await bundle.uploadExecutionPart(node,reuseOp,'artifacts',await portableWorkingArchive(source,sid,coldFiles));
  reuseParts['artifact-0'] = await bundle.uploadExecutionPart(node,reuseOp,'artifact-0',await portableWorkingArchive(source,sid));
  await request(`/api/execution/import/${reuseOp}/finalize`,{parts:reuseParts});
  assert.equal((await request(`/api/execution/import/${reuseOp}/activate`,{})).session.execution_history_only,1);
  await assert.rejects(request(`/api/execution/import/${reuseOp}/prepare`,reuseSpec),/Cold storage plan identity conflict/);
  await assert.rejects(lstat(join(workerRoot,'workspaces',reuseSid,'node_modules/dependency.js')),{code:'ENOENT'});
  assert.equal(await readFile(join(workerRoot,'data/session-artifacts',reuseSid,'old-report/local.txt'),'utf8'),'untracked');
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
  const historySid = 's_device_history', historyOp = 'x_' + 'b'.repeat(24);
  store.createSession({id:historySid,project_id:'p_device_fixture',tool:'agy',tmux:'fixture-history',status:'exited'});
  const historyArtifacts = join(dir,'historical-artifacts'); await mkdir(historyArtifacts);
  await writeFile(join(historyArtifacts,'report.md'),'# Historical report\nOriginal findings retained.\n');
  await writeFile(join(historyArtifacts,'private.md'),'not mentioned by the session');
  store.addMessage(historySid,'out','reply',`Report: ${join(historyArtifacts,'report.md')}`);
  const history = {...state.exportExecutionState(historySid),kind:'move',git:null,historyOnly:true,manifest:{},artifactsPath:historyArtifacts};
  await request(`/api/execution/import/${historyOp}/prepare`,history);
  const historyParts = {tree:await bundle.uploadExecutionPart(node,historyOp,'tree',{command:'/usr/bin/tar',args:['-cf','-','-T','/dev/null']})};
  historyParts.artifacts = await bundle.uploadExecutionPart(node,historyOp,'artifacts',bundle.workingArchive(historyArtifacts));
  await request(`/api/execution/import/${historyOp}/finalize`,{parts:historyParts});
  const historical = await request(`/api/execution/import/${historyOp}/activate`,{});
  assert.equal(historical.session.execution_history_only,1);
  assert.equal(historical.session.execution_checkout,0);
  const oldReportUrl = `${base}/api/session/${historySid}/file?raw=1&path=${encodeURIComponent(join(historyArtifacts,'report.md'))}`;
  const oldReport = await fetch(oldReportUrl);
  assert.equal(oldReport.status,200,'historical report links are remapped even without a runnable Git checkout');
  assert.equal(await oldReport.text(),'# Historical report\nOriginal findings retained.\n');
  assert.equal((await fetch(`${base}/api/session/${historySid}/file?raw=1&path=${encodeURIComponent(join(historyArtifacts,'private.md'))}`)).status,403,
    'an unmentioned sibling is not authorized by the relocation manifest');
  const unrelated = join(dir,'unrelated.txt'); await writeFile(unrelated,'outside the imported session');
  assert.equal((await fetch(`${base}/api/session/${historySid}/file?raw=1&path=${encodeURIComponent(unrelated)}`)).status,403,
    'historical relocation does not grant access outside the imported session');
  await assert.rejects(request(`/api/session/${historySid}/execution/resume`,{force:true}),/preserved historical session/);
  await assert.rejects(lstat(join(workerRoot,'imports',op,'tree')),{code:'ENOENT'},'transfer containers cleaned after activation');
  // A legacy received tar may have both an already portable root dependency and
  // a nested same-project link. Repair extraction locally without retransfers.
  await mkdir(join(source,'aliyun-deploy'));
  const nestedTarget=join(source,'shared/node_modules');
  await symlink(nestedTarget,join(source,'aliyun-deploy/node_modules'));
  const dependencySid='s_device_dependency',dependencyOp='x_'+'e'.repeat(24);
  const dependencyUuid='33333333-2222-4333-8444-555555555555';
  store.createSession({id:dependencySid,project_id:'p_device_fixture',tool:'codex',tmux:'dependency-history',status:'exited'});
  store.updateSession(dependencySid,{worktree_path:source,codex_uuid:dependencyUuid});
  const dependencyNative=join(dir,`rollout-2026-11-01T00-00-00-${dependencyUuid}.jsonl`);
  await writeFile(dependencyNative,JSON.stringify({type:'session_meta',payload:{id:dependencyUuid,cwd:source}})+'\n');
  const dependencyEvidence=await bundle.gitEvidence(source);
  const dependencySpec={...state.exportExecutionState(dependencySid),kind:'move',manifest:{},sourcePath:source,
    native:{uuid:dependencyUuid,name:dependencyNative.split('/').at(-1)},
    git:{...dependencyEvidence,indexReceipt:await bundle.hashFile(dependencyEvidence.index)},gitSeedSession:sid,
    artifactCopyPolicy:{version:2,rebuildDependencies:true,source,originalsRetained:true}};
  await request(`/api/execution/import/${dependencyOp}/prepare`,dependencySpec);
  const dependencyParts={index:await bundle.uploadExecutionPart(node,dependencyOp,'index',dependencyEvidence.index)};
  dependencyParts.git=(await request(`/api/execution/import/${dependencyOp}/git-seed`,{})).receipt;
  dependencyParts.tree=await bundle.uploadExecutionPart(node,dependencyOp,'tree',await portableWorkingArchive(source,sid,coldFiles));
  dependencyParts.native=await bundle.uploadExecutionPart(node,dependencyOp,'native',dependencyNative);
  await assert.rejects(request(`/api/execution/import/${dependencyOp}/finalize`,{parts:dependencyParts}),/External symlink dependency/);
  const dependencyPolicy={version:1,allowedSourceRoots:[source]}, repairedSpec={...dependencySpec,dependencyRebuildPolicy:dependencyPolicy};
  const dependencyUpgrade=await request(`/api/execution/import/${dependencyOp}/prepare`,repairedSpec);
  assert.equal(dependencyUpgrade.phase,'unpacking');assert.deepEqual(dependencyUpgrade.parts,dependencyParts);
  await assert.rejects(request(`/api/execution/import/${dependencyOp}/prepare`,{...repairedSpec,
    dependencyRebuildPolicy:{version:1,allowedSourceRoots:[join(dir,'unrelated-project')]}}),/Dependency rebuild policy conflict/);
  const dependencyResult=await request(`/api/execution/import/${dependencyOp}/finalize`,{parts:dependencyParts});
  const dependencyDirectory=join(workerRoot,'imports',dependencyOp);
  assert.deepEqual(await bundle.hashFile(join(dependencyDirectory,'tree')),dependencyParts.tree,'repair retains the original tar and transfer receipt');
  assert.equal(await readlink(join(dependencyResult.cwd,'aliyun-deploy/node_modules')),'../.aios/execution-rebuilt-dependencies/0');
  assert.ok((await lstat(join(dependencyResult.cwd,'.aios/execution-dependencies/0'))).isDirectory(),'existing portable root dependency is retained');
  assert.equal((await bundle.gitEvidence(dependencyResult.cwd)).statusHash,dependencyEvidence.statusHash,'repair keeps exact source Git evidence');
  assert.equal(await readlink(join(source,'aliyun-deploy/node_modules')),nestedTarget,'original external dependency link remains untouched');
  const dependencyRecord=JSON.parse(await readFile(join(dependencyDirectory,'record.json'),'utf8'));
  assert.equal(dependencyRecord.dependencyRebuild.links[0].path,'aliyun-deploy/node_modules');
  assert.deepEqual(await bundle.hashFile(join(dependencyDirectory,'native')),dependencyParts.native,'exact native receipt is reused');
  await assert.rejects(request(`/api/execution/import/${dependencyOp}/prepare`,dependencySpec),/Dependency rebuild policy conflict/);
  assert.equal((await request(`/api/execution/import/${dependencyOp}/activate`,{})).session.codex_uuid,dependencyUuid);
  console.log(JSON.stringify({pass:true,handler:'actual worker HTTP import',git:'HEAD/index/staged/unstaged/untracked preserved',native:uuid,
    owner:'fixture',paused:true,originals:'retained',duplicateImport:'idempotent',attention:'dismissal retained until new report',transport:'private token'}));
} catch(error) { console.error(logs); throw error; }
finally { if(child?.exitCode == null){child.kill('SIGTERM');await new Promise(r=>child.once('close',r));} store?.db.close(); await rm(dir,{recursive:true,force:true}); }
process.exit(0);
