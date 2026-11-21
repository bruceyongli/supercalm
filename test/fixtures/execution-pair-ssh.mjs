// Test-only SSH stand-in for the installer CLI. Never invokes ssh or launchctl.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFile, writeFile, mkdir, symlink, realpath } from 'node:fs/promises';
const self=fileURLToPath(import.meta.url);
if(process.argv[2]!=='--fixture-mac'){
  const spawn=cp.spawn, exec=cp.execFile, promised=promisify(exec);
  function mapped(file,args){
    if(file!=='/usr/bin/ssh')return [file,args];
    assert.ok(args.includes('BatchMode=yes') && args.includes('StrictHostKeyChecking=yes'));
    assert.equal(args.at(-2),'pair-fixture.invalid');
    return [process.execPath,[self,'--fixture-mac',args.at(-1)]];
  }
  const wrap=(file,args,...options)=>exec(...mapped(file,args),...options);
  wrap[promisify.custom]=(file,args,...options)=>promised(...mapped(file,args),...options);
  cp.execFile=wrap;cp.spawn=(file,args,...options)=>spawn(...mapped(file,args),...options);syncBuiltinESMExports();
}else{
  const command=process.argv[3], home=await realpath(process.env.AIOS_PAIR_FIXTURE_HOME), root=join(home,'.local/share/supercalm-executor');
  const input=async()=>{let result='';for await(const c of process.stdin)result+=c;return result;};
  if(command==='uname -sm'){console.log(process.env.AIOS_PAIR_FIXTURE_OS||'Darwin arm64');}
  else if(command.startsWith('if [ ! -x /opt/homebrew/bin/node ];')){console.log('ready');}
  else if(command.startsWith('/opt/homebrew/bin/node --input-type=module -e ')){
    assert.ok(command.includes('reserveWorker(credential)'));
    const token=await input();assert.ok(!command.includes(token));
    const {reserveWorker}=await import('../../bin/execution-pair-target.mjs');
    console.log(JSON.stringify(await reserveWorker(token,{homeDir:home,loaded:()=>false,check:()=>{},ports:()=>{}})));
  }else if(command==='/opt/homebrew/bin/node --input-type=module'){
    assert.equal(await input(),await readFile('bin/execution-bootstrap.mjs','utf8'));
    const bin=join(root,'runtime/bin');await mkdir(bin,{recursive:true});await symlink(process.execPath,join(bin,'node'));
    await writeFile(join(root,'runtime.json'),JSON.stringify({node:join(bin,'node'),path:bin}));
  }else if(command.includes('/app/bin/execution-worker-service.mjs')){
    const spec=JSON.parse(await input());
    assert.ok(!command.includes(spec.token) && spec.token===(await readFile(join(root,'control-token'),'utf8')).trim());
    assert.equal(spec.sha,cp.execFileSync('/usr/bin/git',['-C',join(root,'app'),'rev-parse','HEAD'],{encoding:'utf8'}).trim());
    assert.equal(spec.root,root);
    await writeFile(join(home,'verified.json'),JSON.stringify({id:spec.id,sha:spec.sha,remotePort:spec.remotePort,callbackPort:spec.callbackPort}));
  }else{
    // The publisher's own fixed bundle receiver / checkout and runtime.json reader,
    // inside this temp Mac only. No commands are accepted from HTTP.
    assert.ok(command.startsWith("/bin/cat '"+root+"/runtime.json'") || command.startsWith("'"+root+"/runtime/bin/node' -e "));
    const task=cp.spawn('/bin/sh',['-c',command],{stdio:'inherit'});
    process.exitCode=await new Promise((ok,fail)=>{task.once('error',fail);task.once('exit',ok);});
  }
}
