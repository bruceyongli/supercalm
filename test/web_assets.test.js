import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWebAssets, assetHtml } from '../src/web_assets.js';

const root = await mkdtemp(join(tmpdir(), 'aios-assets-'));
try {
  const webDir = join(root, 'web'), cacheDir = join(root, 'cache');
  await mkdir(join(webDir, 'views'), { recursive: true });
  await writeFile(join(webDir, 'main.js'), 'import "./views/lazy.js";');
  await writeFile(join(webDir, 'views/lazy.js'), 'export const generation = 1;');
  await writeFile(join(webDir, 'style.css'), 'body { color: red; }');
  await writeFile(join(webDir, 'app.html'), '<base href="/aios/"><script src="main.js"></script>');
  const a = createWebAssets({ webDir, cacheDir });
  const [first, same] = await Promise.all([a.current(), a.current()]);
  assert.equal(first, same, 'single-flight snapshot');
  assert.equal((await readdir(cacheDir)).length, 1);
  const html = assetHtml('<base href="/aios/"><meta name="aios-assets" content=""><link href="style.css"><script src="main.js"></script>'
    + '<a href="session?id=s_one">Session</a><link href="manifest.webmanifest">'
    + '<link href="https://fonts.googleapis.com/css2?family=Test" rel="stylesheet">', first.id);
  assert.match(html, new RegExp(`src="assets/${first.id}/main.js"`));
  assert.match(html, /href="session\?id=s_one"/);
  assert.match(html, /href="manifest.webmanifest"/);
  assert.match(html, /<base href="\/aios\/">/);
  assert.match(html, new RegExp(`name="aios-assets" content="assets/${first.id}/"`));
  assert.match(html, /media="print" onload="this.media='all'"/);
  const asset = await a.get(`/assets/${first.id}/views/lazy.js`);
  assert.match(asset.headers['cache-control'], /immutable/);
  assert.match(asset.body.toString(), /generation = 1/);
  assert.equal(await a.get(`/assets/${first.id}/../app.html`), null);
  assert.equal(await a.get(`/assets/${'f'.repeat(24)}/main.js`), null);
  await writeFile(join(webDir, 'views/lazy.js'), 'export const generation = 2;');
  const b = createWebAssets({ webDir, cacheDir });
  const second = await b.current();
  assert.notEqual(first.id, second.id, 'source change changes every entry-point URL');
  assert.match((await b.get(`/assets/${first.id}/views/lazy.js`)).body.toString(), /generation = 1/,
    'old open tabs still load their exact lazy view after a restart/release');
  assert.match((await b.get(`/assets/${second.id}/views/lazy.js`)).body.toString(), /generation = 2/);
  await writeFile(join(cacheDir, 'operator-note.txt'), 'not an owned cache');
  for (let n = 3; n <= 5; n++) {
    await writeFile(join(webDir, 'views/lazy.js'), `export const generation = ${n};`);
    await createWebAssets({ webDir, cacheDir }).current();
  }
  assert.equal((await readdir(cacheDir)).filter(p => p.startsWith('assets-v1-')).length, 3);
  assert.equal(await readFile(join(cacheDir, 'operator-note.txt'), 'utf8'), 'not an owned cache');
  const budget = createWebAssets({ webDir, cacheDir: join(root, 'small'), maxBytes: 1 });
  await assert.rejects(budget.current(), /byte budget/);
} finally { await rm(root, { recursive: true, force: true }); }
console.log('web_assets: content identity, relative imports, old builds, bounded retention and fresh HTML passed');
