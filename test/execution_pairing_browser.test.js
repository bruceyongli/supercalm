// Real Settings → real controller handler → private registry → authenticated
// worker snapshot → New session picker. Only SSH and remote installation are fixtures.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium, webkit } from 'playwright';
const dir = await realpath(await mkdtemp(join(tmpdir(),'aios-test-pair-browser-')));
Object.assign(process.env,{AIOS_DATA:dir, AIOS_ENV_FILE:join(dir,'absent'),AIOS_EXECUTION_NODES_FILE:join(dir,'registry.json'),
  AIOS_WORKTREE_ROOT:join(dir,'trees'),AIOS_TMUX:'/usr/bin/false',AIOS_AUTO_PUBLISH:'0',AIOS_RELEASE_MONITOR:'0',
  AIOS_EXECUTION_CATALOG_URL:'http://127.0.0.1:1/models',CODEX_HOME:join(dir,'codex'),CLAUDE_CONFIG_DIR:join(dir,'claude')});
delete process.env.AIOS_EXECUTION_NODE;
const delay = ms=>new Promise(r=>setTimeout(r,ms));
let child, browser, logs='';
try {
  const p = createServer(); await new Promise(r=>p.listen(0,'127.0.0.1',r)); const port=p.address().port; await new Promise(r=>p.close(r));
  const base='http://127.0.0.1:'+port+'/aios';
  child=spawn(process.execPath,['--import','./test/fixtures/execution-pair-loopback.mjs','src/server.js'],{
    env:{...process.env,AIOS_HOST:'127.0.0.1',AIOS_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>logs=(logs+b).slice(-2500));
  let ready=false;
  for(let i=0;i<300;i++){if(child.exitCode!==null)throw Error(logs);try {if((await fetch(base+'/readyz')).ok){ready=true;break;}}catch{}await delay(100);}
  assert.ok(ready,'Fixture controller did not start');
  const json=async path=>(await fetch(base+path)).json();
  const {commit}=await json('/api/version'), {preparePairing}=await import('../src/execution_pairing.js');
  const code = await preparePairing({id:'work-mac',host:'pair-fixture.invalid',commit},async()=>join(dir,'worker'));
  const submit=(body,headers={})=>fetch(base+'/api/execution/devices/pair',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await submit({code})).status,403);
  assert.equal((await submit({code},{'x-aios-pairing':'1','sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await submit({code,host:'other.invalid'},{'x-aios-pairing':'1'})).status,400);
  browser=await (process.env.AIOS_PAIR_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.route('**/api/execution/devices', route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"fixture offline"}'}),{times:1});
  // Trigger the same production refresh callback without waiting 15s.
  await page.addInitScript(()=>{const interval=window.setInterval;window.setInterval=function(fn,ms,...args){
    if(ms===15000 && fn.name==='refresh')window.refreshDevices=fn;return interval.call(this,fn,ms,...args);};});
  await page.goto(base+'/settings#st-devices');
  const btn=page.getByRole('button',{name:'Add device',exact:true});
  await page.waitForFunction(()=>{const r=document.querySelector('#st-add-device')?.getBoundingClientRect();return r && r.bottom>0 && r.top<innerHeight;});
  // Real installations have much taller provider/storage inventories than an empty fixture.
  await page.evaluate(()=>{const extra=document.createElement('div');extra.id='test-late-settings';extra.style.height='2500px';document.querySelector('#st-storagecard').before(extra);});
  await page.waitForFunction(()=>{const r=document.querySelector('#st-add-device').getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight;});
  await page.evaluate(()=>{window.dispatchEvent(new WheelEvent('wheel'));window.scrollTo(0,0);document.querySelector('#test-late-settings').style.height='3000px';});
  await page.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))));
  assert.equal(await page.evaluate(()=>scrollY),0,'late settings must not take scroll back from the reader');
  await btn.click();
  const form=page.locator('#st-device-pair');
  const id=form.getByLabel('Device ID'), host=form.getByLabel('SSH address'), proof=form.getByLabel('Pairing code');
  assert.equal(await form.locator('textarea').count(),0);
  const connect=form.getByRole('button',{name:'Connect device'});
  await host.fill('test box');await connect.click();await form.getByText(/Enter a remote SSH alias/).waitFor();
  await host.fill('linux-fixture.invalid');
  assert.equal(await id.inputValue(),'linux-fixture');
  await page.evaluate(()=>window.refreshDevices());
  assert.equal(await host.inputValue(),'linux-fixture.invalid');
  await connect.click();await form.getByText(/SSH connected to Linux/).waitFor();assert.ok(await form.getByText('Open storage settings').isVisible());
  await form.locator('[data-manual] summary').click();await proof.fill('not-a-code');
  await form.getByRole('button',{name:'Use pairing code'}).click();await form.getByText(/code is invalid/).waitFor();
  assert.equal((await json('/api/execution/devices')).devices.length,1);
  await host.fill('pair-fixture.invalid');await id.fill('work-mac');
  await connect.click();await page.waitForFunction(()=>/^[a-f0-9]{40}$/.test(sessionStorage.getItem('aios-device-setup-job')||''));
  await page.reload(); // an interrupted UI follows the operation instead of starting a second install
  await page.locator('.st-device-note').getByText(/added|connected/).waitFor();
  const row=page.locator('[data-execution-device="work-mac"]');await row.waitFor();
  for(let i=0;i<50 && !(await row.innerText()).includes('Connected');i++){await delay(200);await page.evaluate(()=>window.refreshDevices());}
  assert.match(await row.innerText(),/Connected/);assert.equal(await proof.inputValue(),'');
  assert.match(await page.locator('.st-device-note').innerText(),/is connected/);
  const opts=await json('/api/launch-options');
  assert.ok(opts.executionDevices.some(d=>d.id==='work-mac' && d.online && !d.default));
  const registry=JSON.parse(await readFile(process.env.AIOS_EXECUTION_NODES_FILE,'utf8'));
  assert.ok(!JSON.stringify(await json('/api/execution/devices')).includes(registry.nodes[0].token));
  assert.equal((await submit({code},{'x-aios-pairing':'1'})).status,400);
  await page.setViewportSize({width:1440,height:900});await btn.click();await id.fill('another');
  await id.press('Escape');assert.ok(await form.isHidden());assert.equal(await btn.evaluate(el=>el===document.activeElement),true);
  await btn.click();assert.equal(await id.inputValue(),'');
  await form.getByRole('button',{name:'Close'}).click();
  await page.locator('#dk-sess-plus').click();
  await page.locator('#nl-device').waitFor();
  assert.equal(await page.locator('#nl-device option[value="work-mac"]').isEnabled(),true);
  console.log('PASS: mobile + desktop Settings, uninterrupted typing, invalid code, real claim, authenticated Online, available in launch options, replay blocked');
} finally {
  await browser?.close();
  if(child && child.exitCode===null){const stopped=once(child,'close');child.kill('SIGTERM');await stopped;}
  await rm(dir,{recursive:true,force:true});
}
