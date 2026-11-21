// One user-initiated setup at a time. Only fixed release tooling is executable.
// CLI stdout can contain a pairing proof; retain only a bounded tail and never
// return or log it. Only explicitly enumerated messages reach the UI.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ROOT, COMMIT_SHA } from './config.js';
import { claimPairing, checkPairingTarget } from './execution_pairing.js';
import { requireKnownPairHost, pairingErrors, pairError } from './execution_pair_checks.js';
import { assertNewDevice, loadExecutionNodes, connectExecutionNode, executionNode } from './execution_transport.js';
import { migrationError } from './execution_identity.js';

export function runPairInstaller(id, host, stage) {
  return new Promise((resolve,reject)=>{
    const child=spawn(join(ROOT,'bin/deploy'),['--pair-device',id,host],{cwd:ROOT,stdio:['ignore','pipe','pipe'],detached:true});
    let out='',err='',timedOut=false,kill;
    const stop=signal=>{if(child.pid)try{process.kill(-child.pid,signal);}catch{}};
    const timer=setTimeout(()=>{timedOut=true;stop('SIGTERM');kill=setTimeout(()=>stop('SIGKILL'),3000);kill.unref();},22*60_000);
    timer.unref();
    child.stdout.on('data',c=>{
      out=(out+c).slice(-1200);
      if(out.includes('Installing the private runtime'))stage('installing');
    });
    child.stderr.on('data',c=>{err=(err+c).slice(-2000);});
    const clear=()=>{clearTimeout(timer);clearTimeout(kill);};
    child.once('error',()=>{clear();reject(pairError('setup-failed'));});
    child.once('close',code=>{
      clear();
      const proof=out.trimEnd().split('\n').at(-1);
      if(!timedOut && code===0 && proof?.split('.')[0]===id && /^[a-z][a-z0-9_-]{0,39}\.[a-f0-9]{32}$/.test(proof))return resolve(proof);
      const name=err.match(/^AIOS_PAIR_ERROR ([a-z-]+)$/m)?.[1];
      reject(pairError(Object.hasOwn(pairingErrors,name)?name:'setup-failed'));
    });
  });
}
export function createPairJobs({trusted=requireKnownPairHost,registry=loadExecutionNodes,install=runPairInstaller,
  claim=code=>claimPairing(code,COMMIT_SHA),connect=id=>connectExecutionNode(executionNode(id)),now=Date.now}={}) {
  const jobs=new Map(),recent=[];
  const view=j=>({job:j.job,id:j.id,stage:j.stage,...(j.code?{code:j.code,error:pairingErrors[j.code]}:{})});
  return {
    start(id,host){
      checkPairingTarget(id,host);
      for(const [k,j] of jobs) {
        if(j.finished && now()-j.finished>30*60_000){jobs.delete(k);continue;}
        if(j.stage==='added' && j.id===id && j.host===host)return view(j);
        if(!j.finished){if(j.id===id && j.host===host)return view(j); throw migrationError('Another device setup is in progress.','pairing-busy',409);}
      }
      while(recent.length && now()-recent[0]>=10*60_000)recent.shift();
      if(recent.length>=10)throw migrationError('Too many setup attempts. Retry in a few minutes.','pairing-rate',429);
      recent.push(now());const j={id,host,job:randomBytes(20).toString('hex'),stage:'checking'};jobs.set(j.job,j);
      void (async()=>{
        try{
          assertNewDevice(await registry(),{id,host});
          await trusted(host);
          const code=await install(id,host,stage=>{if(stage==='installing')j.stage=stage;});
          if(typeof code!=='string' || code.split('.')[0]!==id)throw pairError('setup-failed');
          j.stage='registering';const result=await claim(code);if(result.id!==id)throw pairError('setup-failed');
          connect(id);j.stage='added';
        }catch(e){j.stage='failed';j.code=Object.hasOwn(pairingErrors,e.code)?e.code:'setup-failed';}
        finally{j.finished=now();}
      })();
      return view(j);
    },
    status(job){const j=jobs.get(job);if(!j || (j.finished && now()-j.finished>30*60_000))throw migrationError('Setup status expired. Check the device list before retrying.','pairing-expired',404);return view(j);}
  };
}
