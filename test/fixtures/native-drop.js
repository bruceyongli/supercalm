import assert from 'node:assert/strict';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join, basename } from 'node:path';

// A selected, disk-backed File still has a name and nonzero size after its native export
// moves, but reading it fails. This is not an in-memory new File(["image"]) happy path.
export async function nativeDrop({page,root,sid,base,uploads}) {
  const dir = join(root,sid), name = 'IMG_0042.jpeg';
  await mkdir(dir);
  const jpeg = Buffer.from(await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 13; c.height = 7;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#ca5240'; ctx.fillRect(0,0,13,7);
    return c.toDataURL('image/jpeg').split(',')[1];
  }), 'base64');
  const stale = join(dir,name), fresh = join(dir,'export.jpeg');
  await writeFile(stale,jpeg); await writeFile(fresh,jpeg);
  await page.evaluate(() => {
    for (const id of ['stale-drop','fresh-drop']) {
      const el=document.createElement('input'); el.type='file'; el.id=id; el.hidden=true; document.body.append(el);
    }
    window.fireNativeDrop = (mode) => {
      const file = document.querySelector('#stale-drop').files[0], next = document.querySelector('#fresh-drop').files[0];
      let inDrop = true;
      let attempts = 0;
      const item = {kind:'file',getAsFile:() => file,
        webkitGetAsEntry:() => mode === 'entry' && ({isFile:true,name:file.name,file:cb => {
          if (!inDrop) throw Error('missed drop event'); setTimeout(() => cb(next),15);
        }}),
        getAsFileSystemHandle:() => inDrop && mode.startsWith('handle') ? Promise.resolve({kind:'file',name:file.name,
          getFile:async () => mode === 'handle-refresh' && attempts++ === 0 ? file : next}) : Promise.resolve(null)};
      const e=new Event('drop',{bubbles:true,cancelable:true});
      Object.defineProperty(e,'dataTransfer',{value:{types:['Files'],files:[file],items:[item],getData:() => ''}});
      document.querySelector('#reply').dispatchEvent(e); inDrop = false;
    };
  });
  await page.locator('#stale-drop').setInputFiles(stale);
  await page.locator('#fresh-drop').setInputFiles(fresh);
  assert.equal(await page.locator('#stale-drop').evaluate(el => el.files[0].size),jpeg.length);
  await rename(stale,join(dir,'retired-export.jpeg'));
  const readError = await page.locator('#stale-drop').evaluate(async el => {
    try { await el.files[0].arrayBuffer(); return ''; } catch(e) { return e.name; }
  });
  assert.ok(readError, 'fixture must reproduce an actual failed native byte read');
  const cards=page.locator('#attachments .attachment-chip');
  for (const mode of ['entry','handle','handle-refresh']) {
    const before=uploads();
    const upload = page.waitForResponse(r => r.url().endsWith('/' + sid + '/upload') && r.status() === 201);
    await page.evaluate(mode => window.fireNativeDrop(mode),mode);
    await page.waitForFunction(() => document.querySelector('#attachments .ready, #attachments .error'));
    assert.equal(await cards.first().evaluate(el => el.classList.contains('ready')),true,mode + ' must recover from ' + readError);
    await page.waitForFunction(() => document.querySelector('#attachments img')?.naturalWidth === 13);
    assert.equal(await cards.locator('.asset-card-name').innerText(),name);
    assert.equal(uploads(),before+1, 'exactly one upload for this drop');
    const {attachment} = await (await upload).json();
    const readBack = await fetch(base + '/api/session/' + sid + '/attachment/' + encodeURIComponent(basename(attachment.path)));
    assert.equal(readBack.headers.get('content-type'),'image/jpeg');
    assert.deepEqual(Buffer.from(await readBack.arrayBuffer()),jpeg);
    await cards.locator('.attachment-remove').click({force:true});
  }
  const before = uploads();
  await page.evaluate(() => window.fireNativeDrop('no-bytes'));
  await page.locator('#attachments .error').waitFor();
  assert.equal(uploads(),before); assert.match(await cards.innerText(),/Not attached/);
  await page.locator('#reply').fill('Do not silently omit my photo.');
  const dialog = page.waitForEvent('dialog').then(async d => { assert.ok(d.message().includes(name)); await d.dismiss(); });
  await Promise.all([dialog,page.locator('#send').click()]);
  assert.equal(await page.locator('#reply').inputValue(),'Do not silently omit my photo.');
  await cards.locator('.asset-card-open').click();
  assert.match(await page.locator('.asset-detail-body').innerText(),/Finder/);
  assert.equal(await page.locator('[data-save-attachment]').isVisible(),false);
  await page.evaluate(() => {
    const f=document.querySelector('#fresh-drop').files[0], e=new Event('paste',{bubbles:true,cancelable:true});
    Object.defineProperty(e,'clipboardData',{value:{types:['Files'],files:[f],items:[],getData:() => ''}});
    document.activeElement.dispatchEvent(e);
  });
  await page.waitForFunction(() => document.querySelector('#attachments .ready img')?.naturalWidth === 13);
  assert.equal(await cards.count(),1); assert.equal(uploads(),before+1);
  await cards.locator('.attachment-remove').click({force:true});
  await page.evaluate(() => window.fireNativeDrop('no-bytes'));
  await page.locator('#attachments .error .asset-card-open').click();
  await rename(join(dir,'retired-export.jpeg'),stale); // user explicitly chooses their saved original
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-replace-attachment]').click(); await (await chooser).setFiles(stale);
  await page.waitForFunction(() => document.querySelector('#attachments .ready img')?.naturalWidth === 13);
  assert.equal(await cards.count(),1); assert.equal(uploads(),before+2);
  await cards.locator('.attachment-remove').click({force:true});
  const empty = await fetch(base + '/api/session/' + sid + '/upload', {method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({name,type:'application/octet-stream',size:0,data_base64:''})});
  assert.equal(empty.status,422);
  console.log(sid + ': stale disk File (' + readError + ') recovered, original JPEG bytes verified on server, unreadable source not sent, picker recovered the draft.');
}
