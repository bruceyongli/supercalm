#!/usr/bin/env node
// Explicit, opt-in live verification. Uses only disposable repositories, native
// homes, SQLite databases and private tmux sockets; never another user's session.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { mkdtemp, mkdir, writeFile, readFile, rm, open, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer } from 'node:net';
import { shquote as quote } from '../src/util.js';
import { initializeExecutionNative } from '../src/execution_native.js';
import { agentInputReady } from '../src/agent_input_ready.js';
import { normalizeClaudeInputScreen, CLAUDE_COMPOSER_FOOTER } from '../src/claude_composer.js';

if (process.argv[2] !== '--live-bb2') throw Error('Explicit --live-bb2 required (starts real disposable coding sessions)');
const exec = promisify(execFile);
const tag = 'verify-' + randomBytes(5).toString('hex'), dir = await realpath(await mkdtemp(join(tmpdir(),'aios-devices-')));
const remoteRoot = '/Users/apple/.local/share/supercalm-executor/' + tag;
const remoteRuntime = JSON.parse((await exec('ssh',['-o','BatchMode=yes','bb2','/bin/cat /Users/apple/.local/share/supercalm-executor/runtime.json'])).stdout);
const runtime = JSON.parse(await readFile(join(homedir(),'.local/share/supercalm-executor/runtime.json'),'utf8'));
const sha = (await exec('git',['rev-parse','HEAD'])).stdout.trim();
const remote = (program, options={}) => {
  const child = spawn('ssh',['-o','BatchMode=yes','bb2',`${quote(remoteRuntime.node)} -e ${quote(program)}`], {stdio:['pipe','pipe','pipe'],...options});
  return child;
};
const done = child=>new Promise((ok,no)=>{child.on('error',no);child.on('close',code=>code===0?ok():no(Error(`fixture command exited ${code}`)));});
async function remoteCode(code) {
  const child = remote(code); let text='',errors='';child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>errors+=b);
  child.stdin.end(); await done(child).catch(e=>{throw Error(e.message+' '+errors);});return text;
}
async function freePort() {const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const port=await freePort(),forward=await freePort();
const remotePort=Number(await remoteCode(`const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})`));
const callback=Number(await remoteCode(`const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})`));
const token=randomBytes(32).toString('hex'), socket=tag+'-controller', data=join(dir,'data');
const base=`http://127.0.0.1:${port}`, trace={commit:sha,fixture:tag,startedAt:new Date().toISOString(),checks:[]};
let server, serverLog, workerStarted=false;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function request(path,body) {
  const response=await fetch(base+path,{...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(90000)});
  const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}
  if(!response.ok)throw Error(`${path} ${response.status}: ${typeof value==='string'?value:JSON.stringify(value)}`);return value;
}
async function until(label, check, timeout=120000) {
  const start=Date.now();let last;
  while(Date.now()-start<timeout){try{last=await check();if(last)return last;}catch(e){last=e.message;}await pause(1000);}
  throw Error(`${label} timed out: ${typeof last==='string'?last:JSON.stringify(last)}`);
}
const storyText=story=>(story.events||[]).filter(e=>e.kind==='report').map(e=>e.text||e.body||'').join('\n');
async function report(sid, expected) {
  return until('native report '+sid,async()=>{
    const story=await request(`/api/session/${sid}/story`);
    return story.meta?.source==='transcript' && storyText(story).includes(expected)?story:false;
  },180000);
}
try {
  await mkdir(data,{recursive:true});
  await initializeExecutionNative(dir);
  await writeFile(join(data,'model_catalog.json'),JSON.stringify(await fetch('http://127.0.0.1:8793/api/models').then(r=>r.json())));
  const receiver=remote(`const fs=require('fs');fs.mkdirSync(${JSON.stringify(remoteRoot)},{recursive:true,mode:448});require('stream/promises').pipeline(process.stdin,fs.createWriteStream(${JSON.stringify(join(remoteRoot,'runtime.bundle'))},{flags:'wx'})).catch(()=>process.exit(1));`);
  receiver.stdout.resume();receiver.stderr.pipe(process.stderr);
  const bundle=spawn('git',['bundle','create','-','HEAD'],{stdio:['ignore','pipe','inherit']});
  await Promise.all([pipeline(bundle.stdout,receiver.stdin),done(receiver),done(bundle)]);
  const workerEnv={AIOS_DATA:join(remoteRoot,'data'),AIOS_HOST:'127.0.0.1',AIOS_PORT:String(remotePort),
    AIOS_EXECUTION_NODE:'bb2-test',AIOS_EXECUTION_ROOT:remoteRoot,AIOS_EXECUTION_NODES_FILE:join(remoteRoot,'absent-nodes.json'),
    AIOS_ENV_FILE:join(remoteRoot,'absent.env'),AIOS_WORKTREE_ROOT:join(remoteRoot,'worktrees'),
    AIOS_TMUX:join(remoteRoot,'tmux'),PATH:remoteRuntime.path,AIOS_TOOL_PATH:remoteRuntime.path,
    CODEX_HOME:join(remoteRoot,'native/codex'),CLAUDE_CONFIG_DIR:join(remoteRoot,'native/claude'),
    AIOS_CODEX_SESSIONS_DIR:join(remoteRoot,'native/codex/sessions'),AIOS_CODEX_HISTORY_FILE:join(remoteRoot,'native/codex/history.jsonl'),
    AIOS_USAGE_CODEX_DIR:join(remoteRoot,'native/codex/sessions'),AIOS_USAGE_CLAUDE_DIR:join(remoteRoot,'native/claude/projects'),
    AIOS_USAGE_AGY_FILE:join(remoteRoot,'native/no-agy.jsonl'),AIOS_USAGE_AGY_CLI_LOG_DIR:join(remoteRoot,'native/no-agy'),
    AIOS_CLAUDE_HOOKS:'1',AIOS_CODEX_NOTIFY:'1',AIOS_AUTO_PUBLISH:'0',AIOS_CONTEXT_INJECT:'0',AIOS_PREFLIGHT_GRILL:'0',
    AIOS_CLI_PROXY_BASE:`http://127.0.0.1:${callback}/api/cli-proxy`,AIOS_CLAUDE_BASE_URL:`http://127.0.0.1:${callback}/api/cli-proxy`,AIOS_CLAUDE_KEY:'sk-aios-via-proxy',
    AIOS_EXECUTION_MODEL_URL:`http://127.0.0.1:${callback}/api/execution/model`,AIOS_EXECUTION_CATALOG_URL:`http://127.0.0.1:${callback}/api/models`};
  await remoteCode(`(async()=>{const fs=require('fs'),cp=require('child_process'),root=${JSON.stringify(remoteRoot)},env=${JSON.stringify(workerEnv)};
    cp.execFileSync('/usr/bin/git',['clone',root+'/runtime.bundle',root+'/app']);
    cp.execFileSync(${JSON.stringify(remoteRuntime.node)},[${JSON.stringify(join(remoteRuntime.node,'../../lib/node_modules/npm/bin/npm-cli.js'))},'ci','--omit=dev','--ignore-scripts'],{cwd:root+'/app',env:{...process.env,PATH:env.PATH},timeout:180000});
    fs.mkdirSync(root+'/data',{recursive:true});fs.writeFileSync(root+'/control-token',${JSON.stringify(token)},{mode:384});
    await import(root+'/app/src/execution_native.js').then(m=>m.initializeExecutionNative(root));
    fs.writeFileSync(root+'/tmux',${JSON.stringify(`#!/bin/sh\nTMUX='' exec /opt/homebrew/bin/tmux -L ${tag}-worker "$@"\n`)},{mode:448});
    const log=fs.openSync(root+'/worker.log','a');const child=cp.spawn(${JSON.stringify(remoteRuntime.node)},[root+'/app/src/server.js'],{cwd:root+'/app',env:{...process.env,...env},detached:true,stdio:['ignore',log,log]});
    fs.writeFileSync(root+'/pid',String(child.pid));child.unref();console.log('worker fixture started');})().catch(e=>{console.error(e.message);process.exit(1)});`);
  workerStarted=true;
  await writeFile(join(dir,'nodes.json'),JSON.stringify({version:1,nodes:[{id:'bb2-test',label:'bb2 test',host:'bb2',root:remoteRoot,localPort:forward,remotePort,callbackPort:callback,token}]}),{mode:0o600});
  const wrapper=join(dir,'tmux');await writeFile(wrapper,`#!/bin/sh\nTMUX='' exec /opt/homebrew/bin/tmux -L ${socket} "$@"\n`,{mode:0o700});
  await mkdir(join(dir,'native/codex'),{recursive:true});
  await writeFile(join(dir,'native/codex/config.toml'),`model_provider="fixture"\n[model_providers.fixture]\nname="Supercalm fixture"\nbase_url="http://127.0.0.1:8793/api/cli-proxy/v1"\nwire_api="responses"\nenv_key="AIOS_PROXY_API_KEY"\n`);
  const env={...process.env,AIOS_DATA:data,AIOS_PORT:String(port),AIOS_HOST:'127.0.0.1',AIOS_ENV_FILE:join(dir,'none.env'),AIOS_EXECUTION_NODES_FILE:join(dir,'nodes.json'),
    AIOS_WORKTREE_ROOT:join(dir,'worktrees'),AIOS_TMUX:wrapper,PATH:runtime.path,AIOS_TOOL_PATH:runtime.path,
    CODEX_HOME:join(dir,'native/codex'),CLAUDE_CONFIG_DIR:join(dir,'native/claude'),AIOS_CODEX_SESSIONS_DIR:join(dir,'native/codex/sessions'),AIOS_CODEX_HISTORY_FILE:join(dir,'native/codex/history.jsonl'),
    AIOS_USAGE_CODEX_DIR:join(dir,'native/codex/sessions'),AIOS_USAGE_CLAUDE_DIR:join(dir,'native/claude/projects'),
    AIOS_USAGE_AGY_FILE:join(dir,'native/no-agy.jsonl'),AIOS_USAGE_AGY_CLI_LOG_DIR:join(dir,'native/no-agy'),
    AIOS_PROXY_API_KEY:'sk-aios-local',AIOS_CLAUDE_BASE_URL:'http://127.0.0.1:8793/api/cli-proxy',AIOS_CLAUDE_KEY:'sk-aios-via-proxy',
    AIOS_CLAUDE_HOOKS:'1',AIOS_CODEX_NOTIFY:'1',AIOS_AUTO_PUBLISH:'0',AIOS_CONTEXT_INJECT:'0',AIOS_PREFLIGHT_GRILL:'0',TMPDIR:dir,TMP:dir,TEMP:dir};
  delete env.AIOS_EXECUTION_NODE;
  serverLog=await open(join(dir,'controller.log'),'a');
  const startController=()=>spawn(process.execPath,['src/server.js'],{cwd:resolve('.'),env,stdio:['ignore',serverLog.fd,serverLog.fd]});
  server=startController();
  await until('controller readiness',()=>fetch(base+'/readyz').then(r=>r.ok));
  await until('device connected',async()=>(await request('/api/execution/devices')).devices.some(d=>d.id==='bb2-test'&&d.online));
  console.log(JSON.stringify({phase:'connected',fixture:tag,controller:base,root:dir}));
  const project=join(dir,'project');await mkdir(project);
  const git=async(...args)=>(await exec('git',['-C',project,...args])).stdout;
  await git('init','-b','main');await git('config','user.email','test@localhost');await git('config','user.name','Validation');
  await writeFile(join(project,'README.md'),'Disposable execution-device validation only.\n');await git('add','.');await git('commit','-m','fixture');
  for(const tool of process.argv.includes('--only-claude') ? ['claude'] : ['codex','claude']) {
    console.log(JSON.stringify({phase:'native-launch',tool}));
    const marker=`LOCAL-${tool}-${tag}`;
    const session=await request('/api/session',{path:project,tool,model:tool==='codex'?'gpt-6.1-sol':'claude-opus-5-5',effort:'low',autonomy:'full',task:`Disposable test. Remember the exact marker ${marker}. Write proof-${tool}.md containing only the marker. Then reply exactly "SAVED ${marker}". Do not start any helper or modify any other file.`});
    await report(session.id,'SAVED '+marker);
    console.log(JSON.stringify({phase:'native-report',tool,session:session.id}));
    await request(`/api/session/${session.id}/stop`,{});
    const original=await request(`/api/session/${session.id}?surface=header`);
    const nativeId=original.codex_uuid||original.claude_transcript?.split('/').at(-1).replace(/\.jsonl$/,'');assert.ok(nativeId);
    await writeFile(join(project,'staged.txt'),'staged '+tool);await git('add','staged.txt');await writeFile(join(project,'staged.txt'),'unstaged '+tool);
    await writeFile(join(project,'untracked.txt'),'untracked '+tool);
    const moved=await request(`/api/session/${session.id}/move`,{device:'bb2-test'});
    await until('handoff '+session.id,async()=>{const op=(await request(`/api/session/${session.id}/move`)).operation;if(op.phase==='failed')throw Error(op.error);return op.phase==='complete';},240000);
    const after=await request(`/api/session/${session.id}?surface=header`);
    console.log(JSON.stringify({phase:'moved',tool,session:session.id,nativeId}));
    assert.equal(after.id,original.id);assert.equal(after.status,'exited');assert.equal(after.execution_node,'bb2-test');
    assert.equal(after.codex_uuid||after.claude_transcript.split('/').at(-1).replace(/\.jsonl$/,''),nativeId);
    const file=await fetch(base+`/api/session/${session.id}/file?path=${encodeURIComponent(join(project,`proof-${tool}.md`))}&raw=1`);
    assert.equal(file.status,200);assert.equal((await file.text()).trim(),marker,'old absolute report links resolve after handoff');
    await request(`/api/session/${session.id}/resume`,{});
    const resumedAt=Date.now();
    await until('native composer ready '+session.id,async()=>{
      const detail=await request(`/api/session/${session.id}`);
      const screen=tool==='claude'?normalizeClaudeInputScreen(detail.snapshot):detail.snapshot;
      return agentInputReady(screen,tool==='claude'?{completeComposer:true,footerPattern:CLAUDE_COMPOSER_FOOTER}:{});
    },60000);
    const resumed = await request(`/api/session/${session.id}`);
    console.log(JSON.stringify({phase:'resumed',tool,session:session.id,status:resumed.status,readyMs:Date.now()-resumedAt}));
    const sent=await request(`/api/session/${session.id}/input`,{text:'What exact marker did I ask you to remember? Reply "REMEMBERED " followed by that marker. Do not read any file or use tools.',source:'text',client_message_id:'verify-'+tool});
    const grounded=await report(session.id,'REMEMBERED '+marker);
    trace.checks.push({tool,session:session.id,nativeId,operation:moved.operation.id,owner:after.execution_node,sendReceipt:sent,report:storyText(grounded),preview:'200 old absolute path',original:await readFile(join(project,`proof-${tool}.md`),'utf8')});
    await request(`/api/session/${session.id}/stop`,{});
  }
  // Genuinely new launches on bb2, rather than only migrated/replayed state.
  for (const tool of ['codex','claude']) {
    const fresh=await request('/api/session',{path:project,device:'bb2-test',tool,model:tool==='codex'?'gpt-6.1-sol':'claude-opus-5-5',effort:'low',autonomy:'full',task:`Reply exactly "REMOTE-FRESH-${tool}-${tag}". No tools.`});
    await report(fresh.id,`REMOTE-FRESH-${tool}-${tag}`);await request(`/api/session/${fresh.id}/stop`,{});
    trace.checks.push({freshLaunch:fresh.id,tool,device:'bb2-test',nativeStory:true});
  }
  server.kill('SIGTERM');await done(server);server=startController();
  await until('reconnected',async()=>(await request('/api/execution/devices')).devices.some(d=>d.id==='bb2-test'&&d.online));
  for(const check of trace.checks.filter(c=>c.session))assert.equal((await request(`/api/session/${check.session}?surface=header`)).status,'exited');
  trace.pass=true;trace.reconnect='same stopped identities retained';
  console.log(JSON.stringify(trace,null,2));
} catch(error) {
  trace.pass=false;trace.error=error.message;console.error(JSON.stringify(trace,null,2));
  const owned = await request('/api/phone/home').catch(()=>({sessions:[]}));
  for (const session of owned.sessions || []) {
    const detail = await request(`/api/session/${session.id}`).catch(()=>null);
    console.error(JSON.stringify({session:session.id,status:detail?.status,autonomy:detail?.autonomy,question:detail?.question,events:detail?.events?.slice(-10),screen:detail?.snapshot?.slice(-6000)}));
  }
  console.error((await readFile(join(dir,'controller.log'),'utf8').catch(()=>'' )).slice(-6000));
  console.error(await remoteCode(`console.log(require('fs').readFileSync(${JSON.stringify(join(remoteRoot,'worker.log'))},'utf8').slice(-6000))`).catch(()=>''));
  process.exitCode=1;
} finally {
  if(server?.exitCode==null){server.kill('SIGTERM');await done(server).catch(()=>{});}await serverLog?.close();
  await exec('/opt/homebrew/bin/tmux',['-L',socket,'kill-server']).catch(()=>{});
  if(workerStarted)await remoteCode(`const fs=require('fs'),cp=require('child_process'),root=${JSON.stringify(remoteRoot)};try{process.kill(Number(fs.readFileSync(root+'/pid','utf8')),'SIGTERM')}catch{};try{cp.execFileSync('/opt/homebrew/bin/tmux',['-L',${JSON.stringify(tag+'-worker')},'kill-server'])}catch{};fs.rmSync(root,{recursive:true,force:true});`).catch(e=>console.error('Remote fixture cleanup:',e.message));
  // The trace is the only retained artifact; no test database, checkout or build cache remains.
  const evidence=join(homedir(),'.local/share/aios/execution-validation');await mkdir(evidence,{recursive:true});
  await writeFile(join(evidence,tag+'.json'),JSON.stringify(trace,null,2)+'\n',{mode:0o600});
  await rm(dir,{recursive:true,force:true});
}
