import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const assets = new Map([
  ['/terminal-file-links.js', ['text/javascript', 'web/terminal-file-links.js']],
  ['/file-reference.js', ['text/javascript', 'web/file-reference.js']],
  ['/xterm.js', ['text/javascript', 'web/vendor/xterm.js']],
  ['/xterm.css', ['text/css', 'web/vendor/xterm.css']],
].map(([url, [mime, file]]) => [url, { mime, body: readFileSync(new URL(`../${file}`, import.meta.url)) }]));
const requests = [];
const fixture = `<!doctype html><link rel="stylesheet" href="/xterm.css">
<style>body {margin: 0} #terminal {width: max-content} #preview {white-space:pre-wrap}</style>
<div id="terminal"></div><div id="preview"></div><script src="/xterm.js"></script>
<script type="module">
  import { terminalFileReferences } from '/terminal-file-links.js';
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
  window.__links = {
    term,
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
  await clickCell(links.at(-1).range.end.x, links.at(-1).row, first);
  await page.evaluate(() => new Promise(resolve => window.__links.term.write('\x1b[?1049l', resolve)));

  // A literal space at the right edge is still a delimiter, not discarded as terminal padding.
  links = await load('docs/one.md ' + ' '.repeat(21) + 'docs/two.md', 32);
  assert.deepEqual([...new Set(links.map(link => link.text))], ['docs/one.md', 'docs/two.md']);
  const url = 'https://example.test/very-long-path/documentation.html?section=wrapping';
  links = await load(`Read ${url}`, 32);
  assert.ok(links.every(link => link.text === url), 'wrapped web URLs retain their full address');
  links = await load('https://example.test/guide\r\nRead this next.');
  assert.deepEqual(links.map(link => link.text), ['https://example.test/guide'], 'external URL must not absorb the next paragraph');
  console.log(`terminal_file_links_browser: passed; ${requests.length} clicks delivered complete paths`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
