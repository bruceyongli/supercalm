import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { mkdir, cp, copyFile, readFile } from 'node:fs/promises';
const exec=promisify(execFile), source=fileURLToPath(new URL('../../',import.meta.url));
export async function exercisePairingCLI(dir){
  const repo=join(dir,'clean-release'),home=join(dir,'ssh-machine'),data=join(dir,'cli-data');
  await mkdir(join(repo,'bin'),{recursive:true});await mkdir(home);
  await cp(join(source,'src'),join(repo,'src'),{recursive:true});
  for(const file of ['package.json','bin/execution-node.mjs','bin/execution-pair-target.mjs','bin/execution-bootstrap.mjs'])await copyFile(join(source,file),join(repo,file));
  const version=JSON.parse(await readFile(join(repo,'package.json'),'utf8')).version;
  const git=async(...args)=>(await exec('/usr/bin/git',['-C',repo,...args])).stdout.trim();
  await git('init','-b','main');await git('add','.');await git('-c','user.name=Fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','commit','-qm','Fixture release');
  const sha=await git('rev-parse','HEAD');await git('-c','tag.gpgSign=false','tag','v'+version);
  const server=createServer((req,res)=>{assert.equal(req.url,'/api/version');res.end(JSON.stringify({version,commit:sha}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const result=await exec(process.execPath,['--import',new URL('./execution-pair-ssh.mjs',import.meta.url).href,'bin/execution-node.mjs','pair','test-mac','pair-fixture.invalid'],{
      cwd:repo,env:{...process.env,AIOS_DATA:data,AIOS_EXECUTION_NODES_FILE:join(data,'registry.json'),AIOS_PORT:String(server.address().port),AIOS_PAIR_FIXTURE_HOME:home},timeout:30000});
    assert.ok(/test-mac\.[a-f0-9]{32}/.test(result.stdout));
    assert.deepEqual(JSON.parse(await readFile(join(home,'verified.json'),'utf8')),{id:'test-mac',sha,remotePort:8794,callbackPort:18793});
    const row=JSON.parse(await readFile(join(data,'execution-pairings','test-mac.json'),'utf8'));
    assert.ok(!result.stdout.includes(row.token) && !result.stderr.includes(row.token));
    await assert.rejects(readFile(join(data,'registry.json')),{code:'ENOENT'}); // no registration before Settings confirmation
  }finally{await new Promise(r=>server.close(r));}
}
