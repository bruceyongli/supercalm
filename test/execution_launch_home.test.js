// Real controller, worker, Git and SQLite. The cold source is deliberately
// unavailable for the retry and both subsequent launches. No real coding CLI.
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,realpath,readFile,writeFile,rename,rm,lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
const exec=promisify(execFile), wait=ms=>new Promise(r=>setTimeout(r,ms));
const dir=await realpath(await mkdtemp(join(tmpdir(),'aios-launch-home-'))), worker=join(dir,'worker'), data=join(dir,'controller');
const cold=join(dir,'source'), offline=join(dir,'offline'), pid='p_launch_test', sid='s_original', op='x_'+'9'.repeat(24), token=randomBytes(32).toString('hex');
const registry=join(dir,'nodes.json'), children=[], servers=new Map();
const git=async(path,...args)=>(await exec('/usr/bin/git',['-C',path,...args])).stdout.trim();
const json=async(port,path,body,workerAuth=false)=>{
  const response=await fetch('http://127.0.0.1:'+port+path,{method:body?'POST':'GET',signal:AbortSignal.timeout(5000),
    headers:{...(body?{'content-type':'application/json'}:{}),...(workerAuth?{'x-aios-node-token':token}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const value=await response.json();if(!response.ok)throw Error(response.status+': '+value.error);return value;
};
const port=async()=>{const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;};
const spawnServer=async(n,values)=>{
  let log='';const child=spawn(process.execPath,['src/server.js'],{env:{...process.env,AIOS_HOST:'127.0.0.1',AIOS_PORT:String(n),
    AIOS_TMUX:join(dir,'tmux'),AIOS_ENV_FILE:join(dir,'no-env'),AIOS_AUTO_PUBLISH:'0',AIOS_RELEASE_MONITOR:'0',...values},stdio:['ignore','pipe','pipe']});
  children.push(child);servers.set(n,child);child.stdout.on('data',b=>log=(log+b).slice(-1800));child.stderr.on('data',b=>log=(log+b).slice(-1800));
  for(let i=0;i<300;i++){if(child.exitCode!=null)throw Error('Fixture server exited: '+log);try{if((await fetch('http://127.0.0.1:'+n+'/readyz')).ok)return;}catch{}await wait(100);}
  throw Error('Fixture server not ready: '+log);
};
let db,wd;
try {
  await Promise.all([mkdir(cold),mkdir(join(worker,'workspaces'),{recursive:true}),mkdir(data)]);
  await git(cold,'init','-b','main');await git(cold,'config','user.email','fixture@localhost');await git(cold,'config','user.name','Fixture');
  await writeFile(join(cold,'plan.md'),'committed\n');await git(cold,'add','plan.md');await git(cold,'commit','-m','base');
  const head=await git(cold,'rev-parse','HEAD');await git(cold,'branch','integration');
  await writeFile(join(cold,'plan.md'),'staged\n');await git(cold,'add','plan.md');await writeFile(join(cold,'plan.md'),'unstaged\n');await writeFile(join(cold,'loose'),'untracked');
  const args=['bin/prepare-execution-launch-home.mjs',pid,cold,head], env={...process.env,AIOS_EXECUTION_ROOT:worker};
  await exec(process.execPath,args,{env});await exec(process.execPath,args,{env}); // idempotent
  const home=join(worker,'projects',pid+'.git');assert.equal(await git(home,'rev-parse','HEAD'),head);
  await writeFile(join(worker,'control-token'),token+'\n',{mode:0o600});
  await writeFile(join(dir,'tmux'),'#!/bin/sh\ncase "$1" in new-session|pipe-pane|set-option|send-keys) exit 0;; esac\nexit 1\n',{mode:0o755});
  const wp=await port(),cp=await port();
  await writeFile(registry,JSON.stringify({version:1,nodes:[{id:'fixture',label:'SSD',host:'localhost',local:true,default:true,root:worker,token,localPort:wp,remotePort:wp,callbackPort:cp}]}));
  await spawnServer(wp,{AIOS_EXECUTION_NODE:'fixture',AIOS_EXECUTION_ROOT:worker,AIOS_DATA:join(worker,'data'),
    AIOS_EXECUTION_NODES_FILE:join(worker,'no-nodes'),AIOS_WORKTREE_ROOT:join(worker,'worktrees'),CODEX_HOME:join(worker,'native/codex'),CLAUDE_CONFIG_DIR:join(worker,'native/claude')});
  await spawnServer(cp,{AIOS_EXECUTION_NODE:'local',AIOS_DATA:data,AIOS_EXECUTION_NODES_FILE:registry,AIOS_WORKTREE_ROOT:join(dir,'worktrees')});
  db=new DatabaseSync(join(data,'aios.db'));wd=new DatabaseSync(join(worker,'data/aios.db'),{readOnly:true});db.exec('PRAGMA busy_timeout=4000');
  db.prepare('INSERT INTO projects(id,name,path,created_at) VALUES(?,?,?,?)').run(pid,'Morph fixture',cold,Date.now());
  const project=db.prepare('SELECT * FROM projects WHERE id=?').get(pid);
  const observe=async id=>{
    for(let i=0;i<240;i++){
      const r=db.prepare('SELECT * FROM execution_operations WHERE session_id=?').get(id);
      if(r?.phase==='failed')throw Error(r.error);if(r?.phase==='complete')return {...r,detail:JSON.parse(r.detail)};await wait(80);
    }throw Error('Operation did not complete: '+id);
  };
  // Unconfigured fresh launches use only the commit, never copy the dirty index or working tree.
  const coldSession=await json(cp,'/api/session',{project_id:pid,tool:'codex',task:'Cold fixture'}),first=await observe(coldSession.id);
  assert.deepEqual(Object.keys(first.detail.parts),['git']);assert.equal(await readFile(join(first.detail.destination,'plan.md'),'utf8'),'committed\n');
  assert.equal(await git(first.detail.destination,'rev-parse','refs/heads/integration'),head);
  assert.equal(await git(first.detail.destination,'status','--porcelain'),'');
  // Simulate the same legacy queued/failed envelope and a worker that received only its index.
  const at=Date.now(),branch='supercalm/Morph-fixture/'+sid;
  db.prepare("INSERT INTO sessions(id,project_id,tool,tmux,title,status,started_at,last_activity,execution_node,status_reason) VALUES(?,?,?,?,?,'error',?,?,?,'execution-launch-failed')").run(sid,pid,'codex','placeholder','Original',at,at,'fixture');
  db.prepare('INSERT INTO messages(session_id,direction,source,text,ts) VALUES(?,?,?,?,?)').run(sid,'in','task','Original request exactly once',at);
  const session=db.prepare('SELECT * FROM sessions WHERE id=?').get(sid),tables={messages:db.prepare('SELECT * FROM messages WHERE session_id=?').all(sid)};
  const spec={session,project,tables,kind:'launch',sourcePath:cold,git:{head,branch,statusHash:'old-index-hash'}};
  await json(wp,'/api/execution/import/'+op+'/prepare',spec,true);
  db.prepare('INSERT INTO execution_operations VALUES(?,?,?,?,?,?,?,?,?)').run(op,sid,'fixture','launch','failed',JSON.stringify({spec,parts:{}}),'legacy error',at,at);
  await assert.rejects(json(cp,'/api/project/'+pid+'/launch-home',{device:'fixture',commit:'0'.repeat(40)}),/match/);
  await rename(cold,offline); // no cold source for registration, retry, new sessions or validation
  await json(cp,'/api/project/'+pid+'/launch-home',{device:'fixture',commit:head});
  assert.equal(db.prepare('SELECT execution_node FROM projects WHERE id=?').get(pid).execution_node,null);
  assert.equal((await json(cp,'/api/session/'+sid+'/resume',{})).id,sid);
  const retry=await observe(sid);assert.equal(retry.id,op);assert.equal(retry.detail.spec.git.head,head);
  assert.equal(wd.prepare("SELECT count(*) n FROM messages WHERE session_id=? AND direction='in' AND text=?").get(sid,'Original request exactly once').n,1);
  const starts=await Promise.all(['one','two'].map(task=>json(cp,'/api/session',{project_id:pid,tool:'codex',task})));
  for(const r of [retry,...await Promise.all(starts.map(s=>observe(s.id)))]){
    assert.equal(r.detail.spec.localLaunch,1);assert.deepEqual(r.detail.parts,{});
    assert.equal(await git(r.detail.destination,'rev-parse','--path-format=absolute','--git-common-dir'),home);
    assert.equal(await git(r.detail.destination,'rev-parse','HEAD'),head);assert.equal(await readFile(join(r.detail.destination,'plan.md'),'utf8'),'committed\n');
    assert.equal(await git(r.detail.destination,'branch','--show-current'),r.detail.spec.git.branch);
  }
  assert.equal(new Set(starts.map(s=>s.id)).size,2);assert.equal(await readFile(join(offline,'loose'),'utf8'),'untracked');
  // A home is a living integration branch, not an eternally cached first commit.
  const integration=join(dir,'local-integration');await git(home,'worktree','add',integration,'main');
  await writeFile(join(integration,'plan.md'),'integrated locally\n');await git(integration,'add','plan.md');await git(integration,'commit','-m','local integrated revision');
  const newest=await git(integration,'rev-parse','HEAD'), next=await json(cp,'/api/session',{project_id:pid,tool:'codex',task:'Follow new local main'});
  assert.equal((await observe(next.id)).detail.spec.git.head,newest);assert.equal(await git(retry.detail.destination,'rev-parse','HEAD'),head);
  await rename(home,home+'.offline');
  const missing=await json(cp,'/api/session',{project_id:pid,tool:'codex',task:'Missing local home'});await assert.rejects(observe(missing.id),/ENOENT|unavailable/);
  assert.equal((await json(cp,'/api/phone/home')).sessions.find(s=>s.id===missing.id).status_reason,'execution-launch-failed');
  assert.equal(db.prepare('SELECT count(*) n FROM messages WHERE session_id=?').get(missing.id).n,1);
  await assert.rejects(lstat(cold),{code:'ENOENT'});
  console.log('PASS: cold committed-only import; exact original retry; two concurrent SSD launches with Spark path absent; unavailable home fails closed.');
} finally {
  for(const child of children)if(child.exitCode==null)child.kill('SIGTERM');
  await Promise.all(children.map(c=>c.exitCode!=null||c.signalCode?null:new Promise(r=>c.once('exit',r))));
  db?.close();wd?.close();await rm(dir,{recursive:true,force:true});
}
