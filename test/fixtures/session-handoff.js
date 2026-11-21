import assert from 'node:assert/strict';

export async function verifySessionHandoff(page,base,sid) {
  // Do not touch the user's system pasteboard. Verify which exact text the real click
  // requests, and test the visible/selectable manual fallback when clipboard is denied.
  await page.evaluate(() => {
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value => {
      if (window.denyCopy) throw Error('clipboard denied'); window.copiedText=value;
    }}});
    document.execCommand = () => false;
  });
  const more=page.locator('#session-more'), key=page.locator('[data-copy-session="id"]'), link=page.locator('[data-copy-session="link"]');
  await more.click();
  assert.equal(await key.locator('code').innerText(),sid);
  await key.click(); assert.equal(await page.evaluate(() => window.copiedText),sid);
  await link.click(); const url=await page.evaluate(() => window.copiedText);
  assert.equal(url,base + '/session?id=' + sid);
  const response=await page.request.get(new URL('api/session/'+encodeURIComponent(sid),url).href);
  assert.equal((await response.json()).id,sid);
  await page.evaluate(() => { window.denyCopy=true; }); await link.click();
  const manual=page.locator('[data-copy-manual]');
  assert.equal(await manual.inputValue(),url); assert.ok(await manual.isVisible());
  assert.equal(await manual.evaluate(e => e.selectionEnd-e.selectionStart),url.length);
  await page.goto(url); await more.click(); assert.equal(await key.locator('code').innerText(),sid);
  await more.click();
}
