import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const assets = new Map([
  ['/terminal-file-links.js', ['text/javascript', 'web/terminal-file-links.js']],
  ['/terminal-layout.js', ['text/javascript', 'web/terminal-layout.js']],
  ['/file-reference.js', ['text/javascript', 'web/file-reference.js']],
  ['/xterm.js', ['text/javascript', 'web/vendor/xterm.js']],
  ['/xterm.css', ['text/css', 'web/vendor/xterm.css']],
].map(([url, [mime, file]]) => [url, { mime, body: readFileSync(new URL(`../${file}`, import.meta.url)) }]));
const requests = [];
const fixture = `<!doctype html><link rel="stylesheet" href="/xterm.css">
<style>body {margin: 0} #terminal {width: max-content} #preview {white-space:pre-wrap}</style>
<div id="terminal"></div><div id="preview"></div><script src="/xterm.js"></script>
<script type="module">
  import { terminalFileReferences, installTerminalLinkTaps } from '/terminal-file-links.js';
  import { fitTerminalGrid } from '/terminal-layout.js';
  import { localFilePath } from '/file-reference.js';
  const term = new Terminal({cols: 100, rows: 18, fontSize: 16, scrollback: 200});
  term.open(document.querySelector('#terminal'));
  term.registerLinkProvider({provideLinks(row, callback) {
    callback(terminalFileReferences(term, row).map(reference => ({...reference, activate: async event => {
      event.preventDefault();
      const path = localFilePath(reference.text);
      document.querySelector('#preview').textContent = await fetch('/api/session/s_wrap/file?path=' + encodeURIComponent(path)).then(r => r.text());
    }})));
  }});
  installTerminalLinkTaps({ element: document.querySelector('#terminal'), term, activate: async reference => {
    document.querySelector('#preview').textContent = await fetch('/api/session/s_wrap/file?path=' + encodeURIComponent(localFilePath(reference.text))).then(r => r.text());
  }});
  window.__links = {
    term,
    fitSettled() {
      let addonCalls = 0;
      const cols = term.cols, rows = term.rows;
      const metrics = () => ({colsCapacity: cols, rowsCapacity: rows, screenRatio: term.cols / cols, cellWidth: 8, cellHeight: 18});
      const addon = {fit() { addonCalls++; term.resize(cols - 3, rows); }};
      fitTerminalGrid(term, addon, metrics);
      return addonCalls;
    },
    async load(text, cols) {
      term.reset(); term.resize(cols, 18);
      document.querySelector('#preview').textContent = '';
      await new Promise(resolve => term.write(text, resolve));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
    all() {
      const found = [];
      for (let row = 1; row <= term.buffer.active.length; row++)
        for (const ref of terminalFileReferences(term, row)) found.push({row, ...ref});
      return found;
    },
    point(x, y) {
      const rect = term.element.querySelector('.xterm-screen').getBoundingClientRect();
      return {x: rect.left + (x - .5) * rect.width / term.cols, y: rect.top + (y - .5 - term.buffer.active.viewportY) * rect.height / term.rows};
    },
  };
</script>`;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (assets.has(url.pathname)) {
    const { mime, body } = assets.get(url.pathname);
    res.writeHead(200, { 'content-type': mime }); res.end(body); return;
  }
  if (url.pathname === '/api/session/s_wrap/file') {
    requests.push(url.searchParams.get('path'));
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`Preview: ${url.searchParams.get('path')}`); return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(fixture);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__links);
  const first = '/Users/bb1/aios/data/session-artifacts/s_3376e22da3/agentic-tutoring-research.md';
  const second = '/Users/bb1/aios/data/session-artifacts/s_3376e22da3/claude-second-opinion.md';
  async function load(text, cols = 100) {
    await page.mouse.move(1490, 890);
    await page.evaluate(({text, cols}) => window.__links.load(text, cols), {text, cols});
    return page.evaluate(() => window.__links.all());
  }
  async function clickCell(x, y, expected) {
    const point = await page.evaluate(({x, y}) => window.__links.point(x, y), {x, y});
    const before = requests.length;
    await page.mouse.move(point.x, point.y);
    // xterm resolves hover links on a short timer before accepting a click.
    await page.waitForTimeout(220);
    assert.equal(await page.evaluate(() => window.__links.fitSettled()), 0,
      'a settled layout tick must not resize xterm and invalidate its hovered link');
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(text => document.querySelector('#preview').textContent === `Preview: ${text}`, expected);
    assert.equal(requests.length, before + 1, 'click issues one preview request');
    assert.equal(requests.at(-1), expected, 'preview receives the complete path, never the row fragment');
  }

  // Screenshot: one path breaks after /Users/bb1/, the other in the filename after a hyphen.
  let links = await load(`I completed a research report (/Users/bb1/\r\naios/data/session-artifacts/s_3376e22da3/agentic-tutoring-research.md), plus a critique\r\n(${second.slice(0, -10)}\r\n${second.slice(-10)}).`, 110);
  assert.deepEqual([...new Set(links.map(link => link.text))], [first, second]);
  for (const link of links) {
    const x = link.row === link.range.start.y ? link.range.start.x : link.range.end.x;
    await clickCell(x, link.row, link.text);
  }

  // Actual Codex report: hard newline and two-space continuation indent, even with tmux capture -J.
  links = await load(`  Research (${first.slice(0, -11)}\r\n  ${first.slice(-11)}), complete.`, 110);
  assert.deepEqual([...new Set(links.map(link => link.text))], [first]);
  await clickCell(4, 2, first);

  // Native xterm soft wraps at desktop/tablet/phone widths. Every visible row maps to one full link.
  for (const cols of [96, 64, 32]) {
    links = await load(`小进 😀 e\u0301 report: (${first})`, cols);
    assert.ok(links.length > 1, `path wraps at ${cols} columns`);
    assert.ok(links.every(link => link.text === first));
    for (const link of links) {
      const x = link.row === link.range.start.y ? link.range.start.x : link.range.end.y === link.row ? link.range.end.x : 3;
      await clickCell(x, link.row, first);
    }
  }

  // Reflow of completed output after a viewport resize keeps correct ranges (xterm leaves its
  // current cursor line for the CLI to redraw, so finish this line before resizing).
  await load(`Result: (${first})\r\n`, 110);
  await page.evaluate(() => window.__links.term.resize(40, 18));
  links = await page.evaluate(() => window.__links.all());
  assert.ok(links.length > 1, 'resizing reflows the completed path across multiple rows');
  assert.ok(links.every(link => link.text === first));
  await clickCell(links.at(-1).range.end.x, links.at(-1).row, first);

  links = await load('docs/one.md\r\ndocs/two.md\r\n/Users/bb1/folder\r\n/Users/bb1/other/report.md');
  assert.deepEqual([...new Set(links.map(link => link.text))], ['docs/one.md', 'docs/two.md', '/Users/bb1/other/report.md'],
    'independent lines do not concatenate separate files or paths');
  links = await load('docs/settings.js\r\n  on');
  assert.deepEqual([...new Set(links.map(link => link.text))], ['docs/settings.json'], 'extension itself can wrap');
  await clickCell(3, 2, 'docs/settings.json');

  // Soft and CLI-inserted wraps coexist, including on the alternate screen used by agent TUIs.
  links = await load(`\x1b[?1049hReport: ${first.slice(0, -11)}\r\n  ${first.slice(-11)}`, 32);
  assert.ok(links.length >= 3);
  assert.ok(links.every(link => link.text === first));
  for (const link of links) {
    const x = link.row === link.range.start.y ? link.range.start.x : link.row === link.range.end.y ? link.range.end.x : 3;
    await clickCell(x, link.row, first);
  }
  await page.evaluate(() => new Promise(resolve => window.__links.term.write('\x1b[?1049l', resolve)));

  // A literal space at the right edge is still a delimiter, not discarded as terminal padding.
  links = await load('docs/one.md ' + ' '.repeat(21) + 'docs/two.md', 32);
  assert.deepEqual([...new Set(links.map(link => link.text))], ['docs/one.md', 'docs/two.md']);
  const url = 'https://example.test/very-long-path/documentation.html?section=wrapping';
  links = await load(`Read ${url}`, 32);
  assert.ok(links.every(link => link.text === url), 'wrapped web URLs retain their full address');
  links = await load('https://example.test/guide\r\nRead this next.');
  assert.deepEqual(links.map(link => link.text), ['https://example.test/guide'], 'external URL must not absorb the next paragraph');
  for (const reference of ['/tmp/报告.md', '/tmp/report(final).html', 'docs/code.js:12:3', 'file:///tmp/My%20report.md', '//example.test/a.html']) {
    links = await load(`Result: (${reference}).`);
    assert.deepEqual([...new Set(links.map(l => l.text))], [reference]);
  }
  links = await load('Result: "/tmp/My report (最终).md"', 32);
  assert.ok(links.every(l => l.text === '/tmp/My report (最终).md'));
  await clickCell(links.at(-1).range.start.x, links.at(-1).row, '/tmp/My report (最终).md');

  // The operator screenshot: independently wrapped paths in adjacent table cells.
  for (const border of ['plain', 'box']) {
    const widths = [19, 58, 58];
    const tableRow = cells => (border === 'box' ? '│' : '') + cells.map((s, i) => s.padEnd(widths[i])).join(border === 'box' ? '│' : '  ') + (border === 'box' ? '│' : '');
    const rule = tableRow(widths.map(n => '─'.repeat(n)));
    const left = '/Users/bb1/aios/data/session-artifacts/s_table/deepseek-harness-luna-v5.html';
    const right = '/Users/bb1/aios/data/session-artifacts/s_table/deepseek-harness-claude-supplied.html';
    const text = [tableRow(['Codebase', 'GPT-6 Luna', 'Supplied Claude']), rule,
      tableRow(['Deepseek Harness', 'Open Luna map (' + left.slice(0, 43), 'Open Claude (' + right.slice(0, 45)]),
      tableRow(['', left.slice(43) + ')', right.slice(45) + ')']), rule].join('\r\n');
    // Wide desktop and physical soft wraps of the same table after a narrow reconnect.
    for (const cols of [150, 80, 40]) {
      links = await load(text, cols);
      const paths = [...new Set(links.map(link => link.text))];
      assert.deepEqual(paths.sort(), [left, right].sort(), `${border} table at ${cols} cols`);
      for (const link of links) await clickCell(link.range.start.x, link.row, link.text);
      assert.ok(links.every(link => link.range.start.y === link.range.end.y), 'column links never create screen-wide hitboxes');
    }
  }
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.goto(`http://127.0.0.1:${server.address().port}/`);
  await phone.waitForFunction(() => window.__links);
  await phone.evaluate(path => window.__links.load(path, 32), first);
  const fragment = await phone.evaluate(() => window.__links.all().at(-1));
  const point = await phone.evaluate(range => window.__links.point(range.start.x, range.start.y), fragment.range);
  const beforeTap = requests.length;
  await phone.touchscreen.tap(point.x, point.y);
  await phone.waitForFunction(path => document.querySelector('#preview').textContent === 'Preview: ' + path, first);
  await phone.waitForTimeout(300);
  assert.equal(requests.length, beforeTap + 1, 'one mobile tap opens a wrapped file exactly once, without mouse hover');
  await phone.close();
  console.log(`terminal_file_links_browser: passed; ${requests.length} clicks delivered complete paths`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
