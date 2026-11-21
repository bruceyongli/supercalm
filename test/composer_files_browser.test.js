import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { chromium, webkit } from 'playwright';
import { textWithAttachmentBlock } from '../src/upload_names.js';

// Real SPA, upload/preview endpoints, receipt DB and Story parser; the only intercepted
// delivery is the final /input so no tmux pane, real account or coding agent is needed.
const root = await mkdtemp(join(tmpdir(), 'aios-composer-drop-')), project = join(root, 'project');
const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
const port = portProbe.address().port; await new Promise(r => portProbe.close(r));
Object.assign(process.env, {AIOS_DATA:join(root,'data'), AIOS_PORT:String(port), AIOS_HOST:'127.0.0.1',
  AIOS_TMUX:'/usr/bin/false', AIOS_CODEX_SESSIONS_DIR:join(root,'native'), AIOS_WORKTREE_ROOT:join(root,'worktrees')});
await mkdir(project);
const store = await import('../src/store.js');
store.createProject({id:'p_drop', name:'Drop fixture', path:project});
const base = 'http://127.0.0.1:' + port + '/aios', pngName = '项目 [初稿].png 对照 🌱.png';
const png64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const textName = '项目  核对（最终）.md', contents = '# 核对\n正文 · 不要改名';
const server = spawn(process.execPath, ['src/server.js'], {stdio:'ignore'}), exited = once(server,'exit');
let browser;
try {
  for (let i = 0; ; i++) {
    if ((await fetch(base + '/api/version').catch(() => null))?.ok) break;
    if (i === 100) throw Error('Fixture server unavailable');
    await new Promise(r => setTimeout(r,100));
  }
  for (const [engine, mobile] of [[chromium,false],[webkit,true]]) {
    const sid = 's_drop_' + engine.name();
    store.createSession({id:sid, project_id:'p_drop', tool:'codex', tmux:'drop_fixture_' + engine.name(), status:'exited', title:'Composer fixture'});
    browser = await engine.launch({headless:true});
    const page = await browser.newPage({viewport:{width:mobile ? 390 : 1280,height:820}, isMobile:mobile, hasTouch:mobile, serviceWorkers:'block'});
    page.setDefaultTimeout(12000);
    await page.route('https://fonts.**/*', r => r.abort());
    await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
    let release, input, uploads = 0;
    const hold = new Promise(r => { release = r; });
    await page.route('**/api/session/' + sid + '/upload', async r => { uploads++; await hold; await r.continue(); });
    await page.route('**/api/session/' + sid + '/input', async r => {
      input = r.request().postDataJSON();
      const msg = store.addMessage(sid,'in',input.source,textWithAttachmentBlock(input.text, input.attachments),{clientMessageId:input.client_message_id,deliveryState:'read'});
      await r.fulfill({json:{ok:true,message:msg}});
    });
    await page.goto(base + '/session?id=' + sid + '&noresize&desktop=1');
    const reply = page.locator('#reply'), cards = page.locator('#attachments .attachment-chip');
    await reply.waitFor(); await reply.fill('Review the attached files.');
    await page.evaluate(({pngName,png64,textName,contents}) => {
      const png = new File([Uint8Array.from(atob(png64), c => c.charCodeAt(0))], pngName, {type:'image/png'});
      const other = new File([contents], textName); // no MIME, FileList only
      const e = new Event('drop', {bubbles:true,cancelable:true});
      Object.defineProperty(e,'dataTransfer',{value:{types:['Files'], files:[png, other],
        items:[{kind:'file',getAsFile:() => new File([png],'image.png',{type:png.type})}], getData:() => ''}});
      document.querySelector('#reply').dispatchEvent(e);
    }, {pngName,png64,textName,contents});
    await page.waitForFunction(() => document.querySelector('#attachments img')?.naturalWidth === 1);
    assert.deepEqual(await cards.locator('.asset-card-name').allTextContents(), [pngName,textName]);
    assert.ok(await cards.first().locator('.asset-card-name').evaluate(el => el.offsetWidth > 2 && getComputedStyle(el).clipPath === 'none'));
    await cards.nth(1).locator('.asset-card-open').click();
    await page.waitForFunction(text => document.querySelector('[role=dialog] .asset-detail-text')?.textContent === text, contents);
    assert.equal(await page.locator('#send').isDisabled(), true, 'preview before upload acknowledgement');
    await page.locator('.asset-detail-close').click(); release();
    await page.waitForFunction(() => document.querySelectorAll('#attachments .ready').length === 2);
    // Same-name file, different content: native image + promised entry, no FileList at all.
    await page.evaluate(name => {
      const f = new File(['second document'],'file.md',{type:'text/markdown'});
      const e = new Event('drop',{bubbles:true,cancelable:true});
      Object.defineProperty(e,'dataTransfer',{value:{types:['Files'],files:[],getData:() => '',
        items:[{kind:'file',getAsFile:() => null,webkitGetAsEntry:() => ({isFile:true,name,file:cb => setTimeout(() => cb(f),0)})}]}});
      document.querySelector('#reply').dispatchEvent(e);
    },textName);
    await page.waitForFunction(() => document.querySelectorAll('#attachments .ready').length === 3);
    await cards.first().locator('.asset-card-open').click();
    await page.waitForFunction(() => document.querySelector('img.asset-detail-image')?.naturalWidth === 1);
    assert.equal(await page.locator('[data-save-attachment]').getAttribute('download'), pngName);
    await page.locator('.asset-detail-close').click();
    await page.locator('#send').click(); await page.waitForFunction(() => !document.querySelector('#attachments .attachment-chip'));
    assert.equal(uploads,3); assert.deepEqual(input.attachments.map(f => f.name), [pngName,textName,textName]);
    assert.equal(new Set(input.attachments.map(f => f.path)).size,3);
    assert.ok(!JSON.stringify(input).includes('blob:') && !JSON.stringify(input).includes(contents));
    const [img, first, second] = input.attachments;
    assert.deepEqual(await readFile(img.path),Buffer.from(png64,'base64'));
    assert.equal(await readFile(first.path,'utf8'),contents); assert.equal(await readFile(second.path,'utf8'),'second document');
    const raw = await fetch(base + '/api/session/' + sid + '/attachment/' + encodeURIComponent(basename(img.path)) + '?download=1');
    assert.equal(raw.status,200); assert.match(raw.headers.get('content-disposition'), /filename\*=UTF-8''/);
    assert.equal(decodeURIComponent(raw.headers.get('content-disposition').split("UTF-8''").at(-1)),pngName);
    await page.reload(); await page.locator('.story-feed').waitFor();
    await page.waitForFunction(name => Array.from(document.querySelectorAll('.story-imgs img')).some(i => i.alt === name && i.naturalWidth === 1),pngName);
    const links = await page.locator('.story-chips a').evaluateAll(els => els.map(a => [a.textContent, new URL(a.href).searchParams.get('path')]));
    for (const a of [first,second]) assert.ok(links.some(([name,path]) => name === a.name && path === a.path));
    // Picker/paste share the previewer. Unsupported formats and empty files must never open a blank pane.
    const wav = Buffer.alloc(44 + 1600);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8,4); wav.write('WAVEfmt ',8); wav.writeUInt32LE(16,16);
    wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(8000,24); wav.writeUInt32LE(16000,28);
    wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(1600,40);
    // A valid, one-page PDF; build the xref offsets rather than depending on an external PDF fixture.
    let pdf = '%PDF-1.4\n'; const offsets = [0];
    for (const obj of ['<</Type/Catalog/Pages 2 0 R>>','<</Type/Pages/Count 1/Kids [3 0 R]>>','<</Type/Page/Parent 2 0 R/MediaBox [0 0 72 72]/Resources <<>>>>']) {
      offsets.push(pdf.length); pdf += (offsets.length - 1) + ' 0 obj\n' + obj + '\nendobj\n';
    }
    const xref = pdf.length; pdf += 'xref\n0 4\n0000000000 65535 f \n' + offsets.slice(1).map(n => String(n).padStart(10,'0') + ' 00000 n \n').join('') +
      'trailer\n<</Size 4/Root 1 0 R>>\nstartxref\n' + xref + '\n%%EOF\n';
    await page.locator('#file-input').setInputFiles([
      {name:'录音.wav',mimeType:'audio/wav',buffer:wav},
      {name:'归档.zip',mimeType:'application/zip',buffer:Buffer.from([80,75,3,4])},
      {name:'空.txt',mimeType:'text/plain',buffer:Buffer.alloc(0)},
      {name:'草稿.html',mimeType:'text/html',buffer:Buffer.from('<h1>标题</h1>')},
      {name:'报告.pdf',mimeType:'application/pdf',buffer:Buffer.from(pdf)},
    ]);
    await page.waitForFunction(() => document.querySelectorAll('#attachments .ready').length === 5);
    for (const [i,preview] of [[0,null],[1,'No inline preview'],[2,'Empty file'],[3,'<h1>标题</h1>']]) {
      await cards.nth(i).locator('.asset-card-open').click();
      if (preview) assert.ok((await page.locator('.asset-detail-text').innerText()).includes(preview));
      else await page.waitForFunction(() => document.querySelector('audio.asset-detail-audio')?.duration > 0);
      assert.ok(await page.locator('[data-save-attachment]').isVisible());
      await page.locator('.asset-detail-close').click();
    }
    await cards.nth(4).locator('.asset-card-open').click();
    const pdfDialog = page.getByRole('dialog',{name:'报告.pdf'});
    assert.equal(await pdfDialog.locator('.attachment-pdf').count(), await page.evaluate(() => navigator.pdfViewerEnabled === false ? 0 : 1));
    assert.equal(await pdfDialog.locator('[data-save-attachment]').evaluate(async a => (await fetch(a.href)).text()),pdf);
    await page.locator('.asset-detail-close').click();
    const count = uploads;
    await page.evaluate(() => {
      const e = new Event('drop',{bubbles:true,cancelable:true});
      Object.defineProperty(e,'dataTransfer',{value:{types:['text/uri-list'], getData:k => k === 'text/uri-list' ? 'file:///only-a-reference.pdf' : ''}});
      document.querySelector('#reply').dispatchEvent(e);
    });
    assert.match(await page.locator('#composer-notice').innerText(), /Only a link/);
    assert.equal(uploads,count);
    await browser.close(); browser = null;
    console.log(engine.name() + ': pre-upload local preview, original labels, real upload/download bytes, duplicate-name Story links and image verified.');
  }
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null) server.kill('SIGTERM'); await exited;
  store.db.close(); await rm(root,{recursive:true,force:true});
}
