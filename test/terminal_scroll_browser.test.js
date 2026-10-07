import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const assets = new Map([
  ['/terminal-scroll.js', ['text/javascript', 'web/terminal-scroll.js']],
  ['/xterm.js', ['text/javascript', 'web/vendor/xterm.js']],
  ['/xterm.css', ['text/css', 'web/vendor/xterm.css']],
].map(([url, [mime, path]]) => [url, { mime, body: readFileSync(new URL(`../${path}`, import.meta.url)) }]));
const fixture = `<!doctype html><link rel="stylesheet" href="/xterm.css"><div id="term"></div>
<script src="/xterm.js"></script><script type="module">
import { installTerminalScrolling, terminalScrollMode, terminalLatestVisible } from '/terminal-scroll.js';
const term = new Terminal({cols: 40, rows: 12, scrollback: 1000, disableStdin: true});
const el = document.querySelector('#term'); term.open(el);
const sent = []; let tool = 'codex', historyPage = 0, localScrolls = 0, nativeScrolls = 0;
const latest = document.createElement('button'); latest.textContent = 'Latest'; el.append(latest);
const updateLatest = () => { latest.hidden = !terminalLatestVisible(term, tool); };
term.onScroll(updateLatest);
el.querySelector('.xterm-viewport').addEventListener('scroll', updateLatest);
const abort = new AbortController();
const scrolling = installTerminalScrolling({element: el, term, getTool: () => tool,
  send(data) { sent.push(data); for (const key of data.match(/\\x1b\\[<(64|65);2;3M/g) || []) historyPage += key.includes('<64;') ? 1 : -1;
    if (data === '\\x1b[1;5F') historyPage = 0;
    term.write('\\x1b[HHistory page ' + historyPage, updateLatest); },
  cellAt: () => ({col: 2, row: 3}), onLocalScroll: () => localScrolls++,
  onNativeScroll: () => nativeScrolls++, signal: abort.signal});
latest.onclick = () => { scrolling.jumpToLatest(); updateLatest(); };
window.testScroll = {term, sent, scrolling, abort, latest,
  native: () => nativeScrolls,
  mode: () => terminalScrollMode(term, tool), local: () => localScrolls,
  async load({alt = true, mouse = false, family = 'codex'} = {}) {
    term.reset(); tool = family; sent.length = 0; historyPage = 0; nativeScrolls = 0;
    await new Promise(r => term.write(Array.from({length: 100}, (_,i) => 'line ' + i + '\\r\\n').join('') +
      (alt ? '\\x1b[?1049h' : '') + (mouse ? '\\x1b[?1000h\\x1b[?1006h' : '') + 'History page 0', r));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    updateLatest();
  },
  wheel(deltaY, extra = {}) { const e = new WheelEvent('wheel', {deltaY, bubbles: true, cancelable: true, ...extra});
    el.querySelector('.xterm-viewport').dispatchEvent(e); return e.defaultPrevented; },
  touch(type, y, count = 1) {
    const touches = Array.from({length: count}, (_,identifier) => new Touch({identifier, target: el,
      clientX: 50, clientY: y, pageX: 50, pageY: y, screenX: 50, screenY: y}));
    const e = new TouchEvent(type, {bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: touches});
    el.querySelector('.xterm-viewport').dispatchEvent(e); return e.defaultPrevented; },
};
</script>`;
const server = createServer((req, res) => {
  const asset = assets.get(req.url);
  res.writeHead(200, {'content-type': asset?.mime || 'text/html'});
  res.end(asset?.body || fixture);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({headless: true});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.testScroll);
  const settle = () => page.waitForTimeout(100);
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({width, height: 800});
    await page.evaluate(() => testScroll.load());
    assert.equal(await page.evaluate(() => testScroll.mode()), 'native-wheel');
    assert.equal(await page.evaluate(() => testScroll.latest.hidden), false, 'native history needs Latest even with zero browser scrollback');
    await page.locator('.xterm-screen').hover();
    await page.mouse.wheel(0, -80);
    await page.waitForFunction(() => testScroll.sent.length === 1);
    assert.deepEqual(await page.evaluate(() => testScroll.sent), ['\x1b[<64;2;3M']);
    assert.match(await page.evaluate(() => testScroll.term.buffer.active.getLine(0).translateToString()), /History page 1/);
    await page.mouse.wheel(0, 80);
    await page.waitForFunction(() => testScroll.sent.length === 2);
    assert.deepEqual(await page.evaluate(() => testScroll.sent), ['\x1b[<64;2;3M', '\x1b[<65;2;3M']);
    assert.match(await page.evaluate(() => testScroll.term.buffer.active.getLine(0).translateToString()), /History page 0/);
    await page.mouse.wheel(0, -80);
    await page.waitForFunction(() => testScroll.sent.length === 3);
    await page.locator('button').click();
    await page.waitForFunction(() => testScroll.sent.length === 4);
    assert.equal(await page.evaluate(() => testScroll.sent.at(-1)), '\x1b[1;5F', 'Latest uses native Ctrl+End, never Enter or guessed arrows');
    await page.waitForFunction(() => testScroll.term.buffer.active.getLine(0).translateToString().includes('History page 0'));
    assert.equal(await page.evaluate(() => testScroll.native()), 3, 'actual native scroll pauses follow, redraws and jumps do not');
  }

  await page.evaluate(async () => {
    await testScroll.load();
    testScroll.touch('touchstart', 200);
    testScroll.touch('touchmove', 280); // finger down reads older output
    testScroll.touch('touchend', 280, 0);
  });
  await page.waitForFunction(() => testScroll.sent.length === 1);
  assert.deepEqual(await page.evaluate(() => testScroll.sent), ['\x1b[<64;2;3M']);
  assert.equal(await page.evaluate(() => testScroll.scrolling.isTouchScrolling()), true, 'swiping must not focus the composer');
  await page.evaluate(() => {testScroll.touch('touchstart', 280); testScroll.touch('touchmove', 200);});
  await page.waitForFunction(() => testScroll.sent.length === 2);
  assert.deepEqual(await page.evaluate(() => testScroll.sent), ['\x1b[<64;2;3M', '\x1b[<65;2;3M']);

  await page.evaluate(async () => {await testScroll.load(); for (let i = 0; i < 40; i++) testScroll.wheel(-2);});
  await page.waitForFunction(() => testScroll.sent.length === 1);
  assert.deepEqual(await page.evaluate(() => testScroll.sent), ['\x1b[<64;2;3M'], 'tiny trackpad events coalesce into one native wheel tick, not a page');
  await page.evaluate(() => testScroll.wheel(-100000));
  await page.waitForFunction(() => testScroll.sent.length === 2);
  assert.equal(await page.evaluate(() => testScroll.sent.at(-1)), '\x1b[<64;2;3M'.repeat(8), 'large gestures are bounded');

  await page.evaluate(async () => {
    await testScroll.load(); testScroll.wheel(-80, {ctrlKey: true}); testScroll.wheel(-80, {deltaX: 200});
    testScroll.touch('touchstart', 200, 2); testScroll.touch('touchmove', 300, 2);
  });
  await settle();
  assert.deepEqual(await page.evaluate(() => testScroll.sent), [], 'zoom, horizontal and multi-touch gestures send no keys');

  await page.evaluate(() => testScroll.load({alt: false}));
  assert.equal(await page.evaluate(() => testScroll.mode()), 'local');
  const before = await page.evaluate(() => testScroll.term.buffer.active.viewportY);
  await page.locator('.xterm-screen').hover();
  await page.mouse.wheel(0, -200);
  await page.waitForFunction(() => !testScroll.latest.hidden);
  assert.ok(await page.evaluate(() => testScroll.term.buffer.active.viewportY) < before, 'normal buffer still scrolls locally');
  assert.deepEqual(await page.evaluate(() => testScroll.sent), []);
  assert.equal(await page.evaluate(() => testScroll.latest.hidden), false, 'local scroll reveals Latest');
  await page.locator('button').click();
  await page.waitForFunction(() => testScroll.latest.hidden && testScroll.term.buffer.active.viewportY === testScroll.term.buffer.active.baseY);
  await page.evaluate(() => { testScroll.term.scrollLines(-3); });
  await page.waitForFunction(() => !testScroll.latest.hidden);
  await page.locator('button').click();
  assert.deepEqual(await page.evaluate(() => testScroll.sent), [], 'local Latest never sends raw keys');

  await page.evaluate(async () => {await testScroll.load({mouse: true, family: 'claude'}); testScroll.wheel(-80);});
  await page.waitForFunction(() => testScroll.sent.length === 1);
  assert.deepEqual(await page.evaluate(() => testScroll.sent), ['\x1b[<64;2;3M'], 'native mouse reporting still takes priority');
  await page.locator('button').click();
  assert.equal(await page.evaluate(() => testScroll.sent.at(-1)), '\x1b[1;5F', 'Claude fullscreen uses its native latest shortcut');
  await page.evaluate(async () => {await testScroll.load({family: 'claude'}); testScroll.wheel(-80);});
  await settle();
  assert.deepEqual(await page.evaluate(() => testScroll.sent), [], 'Claude without mouse reporting receives no guessed wheel keys');
  await page.evaluate(async () => { await testScroll.load({family: 'agy'}); testScroll.scrolling.jumpToLatest(); });
  assert.deepEqual(await page.evaluate(() => testScroll.sent), [], 'unknown alternate-screen apps never receive guessed latest keys');
  await page.evaluate(async () => { await testScroll.load(); testScroll.wheel(-80); testScroll.latest.click(); });
  await settle();
  assert.deepEqual(await page.evaluate(() => testScroll.sent), ['\x1b[1;5F'], 'Latest cancels a pending upward wheel so it cannot undo the jump');
  await page.evaluate(async () => {await testScroll.load(); testScroll.wheel(-80); testScroll.abort.abort();});
  await settle();
  assert.deepEqual(await page.evaluate(() => testScroll.sent), [], 'unmount cancels queued scroll input');
  await page.evaluate(() => testScroll.scrolling.jumpToLatest());
  assert.deepEqual(await page.evaluate(() => testScroll.sent), [], 'unmounted Latest cannot write to a pane');
  assert.deepEqual(errors, [], 'no browser exceptions');
} finally {
  await browser.close();
  await new Promise(r => server.close(r));
}
console.log('terminal_scroll_browser: incremental wheel/touch, native/local Latest, mouse, and teardown passed');
