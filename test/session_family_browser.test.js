import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const now = Date.now(), old = now - 3 * 86400000;
const waiting = { status:'waiting', category:'decision', unread:1, question:'Choose the invitation policy.', summary:'Invitation flow is ready.', last_key:{id:20,ts:now,text:'Choose the invitation policy.'} };
const fixtures = [
  {id:'s_child', parent_session_id:'s_main', title:'手机端验收', project:'Elevate', tool:'claude', status:'working',last_activity:now},
  {id:'s_other',title:'Independent task',project:'Elevate',tool:'codex',last_activity:now,...waiting},
  {id:'s_main',title:'Simplify learning page',project:'Elevate',tool:'codex',status:'working',last_activity:now},
  {id:'s_ask',parent_session_id:'s_main',title:'Permissions review',project:'Elevate',tool:'claude',last_activity:now,...waiting},
  {id:'s_blocked',parent_session_id:'s_main',title:'Preview check',project:'Elevate',tool:'codex',last_activity:now,...waiting,provider_issue:{code:'capacity',phase:'blocked'}},
  {id:'s_stopped',parent_session_id:'s_main',title:'Code review',project:'Elevate',tool:'claude',status:'exited',last_activity:old},
  {id:'s_old_parent',title:'Old coordinator',project:'Morph',tool:'claude',status:'exited',last_activity:old},
  {id:'s_fresh_child',parent_session_id:'s_old_parent',title:'Report layout',project:'Morph',tool:'codex',status:'working',last_activity:now},
  ...Array.from({length:12},(_,i)=>({id:`s_history_${i}`,title:`Historical task ${i}`,project:'Fixture',tool:'codex',status:'exited',last_activity:old})),
];
const resourceIds = [], sends = [], dismissals = [];
const mime = {'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const json = (res, body) => {res.writeHead(200, {'content-type':'application/json'});res.end(JSON.stringify(body));};
const server = createServer(async (req,res) => {
  const url = new URL(req.url,'http://localhost'), path = url.pathname;
  if(path === '/aios/api/phone/home') return json(res,{sessions:fixtures,counts:{working:3,waiting:3,live:6}});
  if(path === '/aios/api/version') return json(res,{version:'test',channel:'every'});
  if(path === '/aios/api/auth/status') return json(res,{mode:'cli'});
  const detail=path.match(/^\/aios\/api\/session\/([^/]+)$/);
  if(detail) {
    const session=fixtures.find(s=>s.id===detail[1]);
    return json(res,{...session,revision:1,project:{id:'p_fixture',name:session?.project},messages:[],events:[],snapshot:''});
  }
  if(path === '/aios/api/product/resources/sessions') {
    const ids = url.searchParams.get('ids').split(',');resourceIds.push(...ids);
    return json(res,{state:'ready',sessions:ids.map(id=>({id,cpu_percent:6.2,memory_bytes:512*1024**2,disk_bytes:2*1024**3,checked_at:Date.now(),disk_checked_at:Date.now()}))});
  }
  if(path.endsWith('/input')) {
    let body='';for await(const c of req)body+=c;
    sends.push({path,...JSON.parse(body)});return json(res,{ok:true});
  }
  if(path === '/aios/api/messages/read') {
    let body='';for await(const c of req)body+=c;
    const data=JSON.parse(body);if(data.dismiss)dismissals.push(data.session_id);
    return json(res,{ok:true,unread:0,dismissal:{dismissed:true,dismissed_at:Date.now()}});
  }
  if(path.startsWith('/aios/api/'))return json(res,{});
  let name=path.replace(/^\/aios\/?/,'')||'app.html';
  if(name==='phone')name='phone.html';else if(!extname(name))name='app.html';
  const file=normalize(join(webRoot,name));
  if(!file.startsWith(webRoot)){res.writeHead(403);return res.end();}
  try{res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream'});res.end(readFileSync(file));}
  catch{res.writeHead(404);res.end();}
});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const base=`http://127.0.0.1:${server.address().port}/aios/`;
try {
  for(const [engine,width] of [[chromium,1440],[chromium,820],[webkit,390]]) {
    const browser=await engine.launch({headless:true});
    try {
      const page=await browser.newPage({viewport:{width,height:1100}});
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.route('https://fonts.**/*',r=>r.abort());
      await page.addInitScript(()=>{window.EventSource=class{addEventListener(){}close(){}};});
      resourceIds.length=0;
      await page.goto(base+'?desktop=1');
      const rail=page.locator('#dk-sessions');
      const group=rail.locator('[data-agent-family="s_main"]');
      await group.waitFor({state:'attached'});
      if(width<721)await page.locator('#dk-menu-btn').click();
      assert.equal(await group.locator('.dk-agent-helpers').getAttribute('open'),null,'helpers collapse by default');
      assert.equal(await group.locator('[data-helper-count]').textContent(),'4 helpers');
      assert.equal(await group.locator('[data-helper-needs]').textContent(),'1 needs you');
      assert.equal(await group.locator('[data-helper-blocked]').textContent(),'1 blocked');
      assert.equal(await rail.locator(':scope > [data-sid="s_other"]').count(),1,'same project is not grouped');
      assert.equal(await rail.locator(':scope > [data-agent-family="s_old_parent"]').count(),1,'fresh child keeps a stopped/old parent reachable');
      await page.waitForFunction(()=>document.querySelector('#dk-sessions [data-sid="s_main"] [data-resource="cpu"] .dk-res-value')?.textContent==='6.2%');
      assert(!resourceIds.includes('s_child'),'collapsed helpers do not cause telemetry polling');
      await group.locator('.dk-agent-helpers > summary').click();
      const child=group.locator('[data-dk-sess][data-sid="s_child"]');
      await child.scrollIntoViewIfNeeded();
      await page.waitForFunction(()=>document.querySelector('#dk-sessions [data-sid="s_child"] [data-resource="cpu"] .dk-res-value')?.textContent==='6.2%');
      assert.equal(await child.locator('.dk-agent').textContent(),'claude');
      assert.match(await child.locator('.dk-sess-l2').innerText(),/Elevate[\s\S]*CPU[\s\S]*6\.2%[\s\S]*RAM[\s\S]*512M[\s\S]*Disk[\s\S]*2G/);
      assert(await child.locator('.dk-sess-age').textContent());
      await page.evaluate(async()=>{
        window.keptRow=document.querySelector('#dk-sessions [data-sid="s_child"]');
        window.keptDot=keptRow.querySelector('.dk-dot');window.keptCpu=keptRow.querySelector('[data-resource="cpu"] .dk-res-value');
        const {upsertSession}=await import('/aios/shell.js');
        upsertSession({id:'s_child',summary:'New progress; no hierarchy change',last_activity:Date.now()});
      });
      assert(await page.evaluate(()=>keptRow===document.querySelector('#dk-sessions [data-sid="s_child"]')&&keptDot===keptRow.querySelector('.dk-dot')&&keptCpu===keptRow.querySelector('[data-resource="cpu"] .dk-res-value')&&keptCpu.textContent==='6.2%'));
      await page.evaluate(async()=>{const {upsertSession}=await import('/aios/shell.js');upsertSession({id:'s_child',status:'exited'});});
      await group.locator('.dk-agent-stopped > summary').click();
      assert(await child.isVisible());
      assert(await page.evaluate(()=>keptRow===document.querySelector('#dk-sessions [data-sid="s_child"]')),'moving to Stopped retains the row');
      assert.equal(await group.locator('[data-helper-stopped-count]').textContent(),'2');
      assert(await page.evaluate(()=>[...document.querySelectorAll('#dk-sessions .dk-sess-l2')].filter(e=>e.getBoundingClientRect().width).every(e=>e.scrollWidth<=e.clientWidth+1)),'all resource values fit nested rows');
      await group.locator('.dk-agent-helpers > summary').click();
      await page.evaluate(async()=>{const {upsertSession}=await import('/aios/shell.js');upsertSession({id:'s_child',title:'Readable updated name'});});
      assert.equal(await group.locator('.dk-agent-helpers').getAttribute('open'),null,'SSE cannot reopen a collapsed group');
      await group.locator('.dk-agent-helpers > summary').focus();
      await page.keyboard.press('Enter');
      await page.reload();await group.waitFor({state:'attached'});
      assert.equal(await group.locator('.dk-agent-helpers').getAttribute('open'),'','expansion survives reload');
      if(width<721 && !(await page.locator('body').evaluate(e=>e.classList.contains('dk-drawer'))))await page.locator('#dk-menu-btn').click();
      await page.waitForFunction(()=>document.querySelector('#dk-sessions [data-sid="s_child"] [data-resource="cpu"] .dk-res-value')?.textContent==='6.2%');
      if(process.env.AIOS_GROUP_SCREENSHOT_DIR)await page.screenshot({path:join(process.env.AIOS_GROUP_SCREENSHOT_DIR,`grouping-${width}.png`)});
      if(width<721 && await page.locator('body').evaluate(e=>e.classList.contains('dk-drawer'))) {
        await page.locator('#dk-menu-btn').click();
        await page.waitForFunction(()=>document.querySelector('.dk-side').getBoundingClientRect().right<=0);
      }
      const card=page.locator('#dk-cards [data-sid="s_ask"]');
      assert.equal(await card.locator('.dk-parent-context a').getAttribute('href'),'session?id=s_main');
      assert.equal(await page.locator('#dk-cards [data-dk-card]').count(),3,'similar reports are never silently discarded');
      const cardGeometry=await page.locator('#dk-cards').evaluate(el=>({right:el.getBoundingClientRect().right,innerWidth,viewport:visualViewport.width,scroll:document.documentElement.scrollWidth}));
      assert(cardGeometry.right<=width,`attention cards fit the actual device width: ${JSON.stringify(cardGeometry)}`);
      if(width<721 && process.env.AIOS_GROUP_SCREENSHOT_DIR)await page.screenshot({path:join(process.env.AIOS_GROUP_SCREENSHOT_DIR,`grouping-needs-${width}.png`)});
      await card.locator('[data-dk-reply]').click();await card.locator('textarea').fill('Only invited people may join.');
      await card.locator('[data-dk-send]').click();
      await page.waitForFunction(()=>!document.querySelector('#dk-cards [data-sid="s_ask"]'));
      assert.equal(sends.at(-1).path,'/aios/api/session/s_ask/input','reply reaches the exact child, not a sibling or parent');
      await page.locator('#dk-cards [data-sid="s_blocked"] [data-dk-dismiss]').click();
      await page.waitForFunction(()=>!document.querySelector('#dk-cards [data-sid="s_blocked"]'));
      assert.equal(dismissals.at(-1),'s_blocked');
      assert.equal(await page.locator('#dk-cards [data-sid="s_other"]').count(),1,'unrelated identical report remains');
      assert.equal(await page.locator('#dk-rows [data-dk-row][data-sid^="s_history_"]').count(),10,'stopped standalone history stays bounded, not deleted');
      await page.locator('#dk-rows [data-dk-stopped-toggle]').click();
      assert.equal(await page.locator('#dk-rows [data-dk-row][data-sid^="s_history_"]').count(),12,'all previous stopped rows remain accessible');
      await page.evaluate(async()=>{
        const {renderGroupedSessionList}=await import('/aios/session-groups.js');
        const box=document.createElement('div');document.body.append(box);
        const rows=[{id:'root',status:'waiting',last_activity:1},{id:'leaf',status:'exited',last_activity:1,parent_session_id:'root'}];
        const opts={rowSpec:s=>({html:`<a>${s.id}</a>`}),mode:'selection-test',activeId:'leaf'};
        renderGroupedSessionList(box,rows,opts);
        if(![...box.querySelectorAll('details')].every(d=>d.open))throw Error('selected old/stopped helper must be revealed');
        box.querySelector('.dk-agent-helpers > summary').click();
        renderGroupedSessionList(box,rows,opts);
        if(box.querySelector('.dk-agent-helpers').open)throw Error('repeat render cannot undo explicit collapse');
        box.remove();
      });
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      assert.deepEqual(errors,[]);
      console.log(JSON.stringify({engine:engine.name(),width,grouping:true,metrics:'all retained',nodes:'stable',expansion:'persistent',reply:'exact child',dismiss:'exact report'}));
      await page.goto(base+'session?id=s_child');
      const parentLink=page.locator('#s-title .session-parent-link');await parentLink.waitFor();
      assert.equal(await parentLink.getAttribute('href'),'session?id=s_main');
      const header=await parentLink.evaluate(el=>({right:el.getBoundingClientRect().right,container:document.querySelector('#s-title').getBoundingClientRect().right,titleWidth:document.querySelector('#session-title-value').getBoundingClientRect().width}));
      assert(header.right<=header.container && header.titleWidth>0,`parent navigation cannot hide the child title: ${JSON.stringify(header)}`);
      await page.evaluate(()=>{window.familyNavigationSentinel=true;});
      await parentLink.click();
      await page.waitForFunction(()=>document.querySelector('#session-title-value')?.textContent==='Simplify learning page');
      assert(await page.evaluate(()=>familyNavigationSentinel),'parent navigation reuses the same SPA document');
      assert.deepEqual(errors,[]);
      if(width===390) {
        await page.goto(base+'phone');
        const phoneGroup=page.locator('[data-agent-family="s_main"]');await phoneGroup.waitFor();
        await phoneGroup.locator('[data-helper-toggle="s_main"]').click();
        assert(await phoneGroup.locator('[data-open="s_child"]').isVisible());
        await page.locator('#refresh-needs').click();
        await page.waitForFunction(()=>!document.querySelector('#refresh-needs')?.disabled);
        assert.equal(await page.locator('[data-helper-toggle="s_main"]').getAttribute('aria-expanded'),'true');
        assert.equal(await page.locator('.needcard[data-open="s_ask"] [data-parent-session]').getAttribute('href'),'session?id=s_main');
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        assert.deepEqual(errors,[]);
        console.log('Phone companion: same parentage, saved expansion and correct source links');
      }
      await page.close();
    } finally {await browser.close();}
  }
} finally {await new Promise(ok=>server.close(ok));}
