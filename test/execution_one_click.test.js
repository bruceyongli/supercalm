import assert from 'node:assert/strict';
import { authorizeDeviceSetup, peerPid } from '../src/execution_pair_authority.js';
import { createPairJobs } from '../src/execution_pair_jobs.js';
import { inspectPairPlatform, requireKnownPairHost, sshFailure } from '../src/execution_pair_checks.js';

const socket={remoteAddress:'127.0.0.1',remotePort:54321,localAddress:'127.0.0.1',localPort:8793};
const table=['tcp4 0 0 127.0.0.1.8793 127.0.0.1.54321 ESTABLISHED 0 0 0 0 node:123',
  'tcp4 0 0 127.0.0.1.54321 127.0.0.1.8793 ESTABLISHED 0 0 0 0 tailscaled:321'].join('\n');
assert.equal(peerPid(table,socket),'321');assert.throws(()=>peerPid(table,{...socket,remotePort:54320}));
const dns='controller.example.ts.net',url='https://'+dns,key=dns+':443',selfIp='192.0.2.1';
const req={socket,headers:{origin:url,'x-aios-pairing':'1','sec-fetch-site':'same-origin','content-type':'application/json','tailscale-user-login':'owner@example.invalid',
  'x-forwarded-host':dns,'x-forwarded-proto':'https','x-forwarded-for':'192.0.2.2'}};
const state={Self:{UserID:22,Tags:['tag:controller'],TailscaleIPs:[selfIp]},User:{4:{LoginName:'owner@example.invalid'}},CurrentTailnet:{Name:'owner@example.invalid'}};
const serve={Web:{[key]:{Handlers:{'/aios':{Proxy:'http://127.0.0.1:8793'}}}},AllowFunnel:{}};
const deps={uid:501,operator:'',peer:async()=>({uid:0,exe:'/usr/local/bin/tailscaled'}),network:async()=>({state,serve})};
const authorize=(changes={},options={})=>authorizeDeviceSetup({...req,headers:{...req.headers,...changes}},{...deps,...options});
await authorize();
await authorize({'tailscale-user-login':'','x-forwarded-for':selfIp});
for(const headers of [{'tailscale-user-login':'other@example.invalid'},{'tailscale-user-login':''},{'sec-fetch-site':'cross-site'},
  {origin:'https://other.example.ts.net'},{'x-forwarded-host':'other.example.ts.net'},{'x-forwarded-proto':'http'},{'x-aios-node-token':'worker'},{'tailscale-funnel-request':'?1'}])
  await assert.rejects(authorize(headers),{status:403});
await assert.rejects(authorize({},{peer:async()=>({uid:501,exe:'/usr/bin/ssh'})}),{status:403});
await assert.rejects(authorize({},{network:async()=>({state,serve:{...serve,AllowFunnel:{[key]:true}}})}),{status:403});
await assert.rejects(authorize({},{network:async()=>({state:{...state,CurrentTailnet:{Name:'company.invalid'}},serve})}),{status:403});
const loopHeaders={origin:'http://localhost:8793',host:'localhost:8793'};
await authorize(loopHeaders,{peer:async()=>({uid:501,exe:'/Applications/Safari.app/Contents/MacOS/Safari'})});
await assert.rejects(authorize(loopHeaders,{peer:async()=>({uid:501,exe:'/usr/bin/ssh'})}),{status:403});

let commands=[];
await assert.rejects(inspectPairPlatform(async (_input,_ms,command)=>{commands.push(command);return 'Linux aarch64\n';}),{code:'linux-host'});
assert.deepEqual(commands,['uname -sm']);
await assert.rejects(inspectPairPlatform(async (_i,_t,c)=>c==='uname -sm'?'Darwin arm64':'tmux'),{code:'mac-tmux'});
await inspectPairPlatform(async (_i,_t,c)=>c==='uname -sm'?'Darwin arm64':'ready');
assert.equal(sshFailure({stderr:'Permission denied (publickey)'}).code,'ssh-auth');
assert.equal(sshFailure({stderr:'Host key verification failed'}).code,'unknown-host-key');
let lookup;
await requireKnownPairHost('operator@alias',async (file,args)=>{
  if(file==='/usr/bin/ssh'){assert.equal(args[0],'-G');return {stdout:'hostname target.invalid\nport 2222\nuserknownhostsfile /fixture/known'};}
  lookup=args;return {stdout:''};
});assert.deepEqual(lookup,['-F','[target.invalid]:2222','-f','/fixture/known']);
await assert.rejects(requireKnownPairHost('unknown',async (file)=>{if(file==='/usr/bin/ssh')return {stdout:'hostname unknown.invalid\nport 22'};throw Error('not pinned');}),{code:'unknown-host-key'});

let start,entered,connects=0,installs=0,unblock;
const ready=new Promise(r=>entered=r),block=new Promise(r=>unblock=r);
const jobs=createPairJobs({trusted:async()=>{},registry:async()=>[],connect:id=>{assert.equal(id,'my-mac');connects++;},
  install:async(id,_host,stage)=>{installs++;stage('installing');entered();await block;return id+'.'+'a'.repeat(32);},
  claim:async code=>{assert.equal(code,'my-mac.'+'a'.repeat(32));return {id:'my-mac'};}});
start=jobs.start('my-mac','user@fixture.invalid');await ready;
assert.equal(jobs.start('my-mac','user@fixture.invalid').job,start.job);
assert.throws(()=>jobs.start('other','other.invalid'),{status:409});assert.equal(jobs.status(start.job).stage,'installing');
unblock();await new Promise(r=>setImmediate(r));assert.equal(jobs.status(start.job).stage,'added');assert.equal(connects,1);assert.equal(installs,1);
assert.equal(jobs.start('my-mac','user@fixture.invalid').job,start.job); // lost reply after a successful install
assert.ok(!JSON.stringify(jobs.status(start.job)).includes('a'.repeat(32)));
const failed=createPairJobs({trusted:async()=>{throw Error('private detail');},registry:async()=>[],install:()=>assert.fail()});
const bad=failed.start('mac','unknown.invalid');await new Promise(r=>setImmediate(r));assert.equal(failed.status(bad.job).stage,'failed');
assert.ok(!JSON.stringify(failed.status(bad.job)).includes('private detail'));assert.throws(()=>failed.status('unknown'),{status:404});
console.log('PASS: operator identity, private Serve/loopback, pinned SSH targets, read-only platform checks, bounded idempotent setup');
