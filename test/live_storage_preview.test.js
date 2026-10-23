import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rename,symlink,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {execFileSync} from 'node:child_process';

// Outside the host's generic temp scope, so exact mentions alone cannot mask a
// broken session-storage boundary. Every file/database here belongs to this test.
await mkdir(join(process.cwd(),'test-results'),{recursive:true});
const root=await realpath(await mkdtemp(join(process.cwd(),'test-results/live-storage-preview-')));
process.env.AIOS_DATA=join(root,'data');process.env.AIOS_TMUX='/usr/bin/false';
process.env.AIOS_WORKTREE_ROOT=join(root,'worktrees');process.env.AIOS_CODEX_SESSIONS_DIR=join(root,'native');
process.env.AIOS_HOST='127.0.0.1';process.env.AIOS_SUMMARY_PORT='1';delete process.env.AIOS_NO_LISTEN;
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
process.env.AIOS_PORT=String(probe.address().port);await new Promise(r=>probe.close(r));
const project=join(root,'project'),source=join(process.env.AIOS_DATA,'session-artifacts');
const mount=join(root,'mounts','spark'),target=join(mount,'bb1','artifacts');
const local=join(source,'s_preview','report'),sibling=join(source,'s_other','report');
await Promise.all([mkdir(project),mkdir(process.env.AIOS_CODEX_SESSIONS_DIR),mkdir(local,{recursive:true}),
  mkdir(sibling,{recursive:true}),mkdir(join(mount,'bb1'),{recursive:true})]);
execFileSync('git',['-C',project,'init','-b','main'],{stdio:'ignore'});
const html='<!doctype html><h1>Migrated report</h1><script src="app.js"></script>';
const csv='字词,说明\n迁移,保留原文件\n';
await writeFile(join(local,'index.html'),html);await writeFile(join(local,'app.js'),'window.saved=true;');
await writeFile(join(local,'说明.csv'),csv);await writeFile(join(local,'plan.md'),'# Plan\n\nGrounded migration details.');
await writeFile(join(sibling,'private.txt'),'other session');await writeFile(join(root,'private.txt'),'outside every approved root');
await symlink(join(root,'private.txt'),join(local,'escape.txt'));
let store;
try {
  store=await import('../src/store.js');
  store.createProject({id:'p_preview',name:'Storage preview fixture',path:project});
  for(const id of ['s_preview','s_other'])store.createSession({id,project_id:'p_preview',tool:'codex',tmux:'fixture-'+id,status:'exited'});
  store.addMessage('s_preview','out','reply',[join(local,'index.html'),join(local,'说明.csv'),join(local,'plan.md'),
    join(local,'escape.txt'),join(sibling,'private.txt')].join('\n'));
  const{featureReady}=await import('../src/server.js');await featureReady;
  const base='http://127.0.0.1:'+process.env.AIOS_PORT;
  const request=(path,extra='',sid='s_preview')=>fetch(base+'/api/session/'+sid+'/file?path='+encodeURIComponent(path)+extra);
  const before=await request(join(local,'index.html'));assert.equal(before.status,200);
  const original=(await before.json()).renderUrl;
  assert.equal(await(await fetch(base+'/'+original)).text(),html);
  await rename(source,target);await symlink(target,source);
  const config={version:1,id:'fixture',mount,mappings:[{source,target,active:true}]};
  await writeFile(join(process.env.AIOS_DATA,'live-storage.json'),JSON.stringify(config));
  for(const path of [join(local,'index.html'),join(target,'s_preview','report','index.html')]) {
    const response=await request(path);assert.equal(response.status,200,'logical and registered physical paths stay authorized');
    const meta=await response.json();assert.equal(meta.renderUrl,original,'existing rendered links keep their token');
    assert.equal(await(await fetch(base+'/'+meta.renderUrl)).text(),html);
    assert.equal(await(await fetch(new URL('app.js',base+'/'+meta.renderUrl))).text(),'window.saved=true;');
  }
  for(const extra of ['&raw=1','&raw=1&download=1']) {
    const response=await request(join(local,'说明.csv'),extra);assert.equal(response.status,200);assert.equal(await response.text(),csv);
  }
  const {resolveSessionFile}=await import('../src/sessions.js');
  const{buildVoiceSourcePack}=await import('../src/voice_sources.js');
  const pack=await buildVoiceSourcePack({session:store.getSession('s_preview'),reportText:join(local,'plan.md'),resolveFile:resolveSessionFile});
  assert.equal(pack.sources.length,1);assert.match(JSON.stringify(pack),/Grounded migration details/);
  assert.equal((await request(join(local,'index.html'),'','s_other')).status,403,'another session cannot borrow the migrated report');
  for(const path of [join(local,'escape.txt'),join(sibling,'private.txt')])assert.equal((await request(path)).status,403,'a mention never grants an escaped or sibling file: '+path);
  await writeFile(join(process.env.AIOS_DATA,'live-storage.json'),JSON.stringify({...config,mappings:[]}));
  assert.equal((await request(join(local,'index.html'))).status,403,'an unregistered symlink cannot impersonate managed storage');
  assert.equal((await fetch(base+'/'+original)).status,403,'render grants cannot bypass a removed mapping');
  console.log('live storage preview: real HTTP, stable render tokens, Unicode downloads, relative assets, voice sources, isolated session scope');
} finally {store?.db.close();await rm(root,{recursive:true,force:true});}
process.exit(0);
