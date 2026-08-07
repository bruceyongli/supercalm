import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});

const port = await freePort();
const data = await mkdtemp(join(tmpdir(), 'aios-projects-browser-data-'));
const projectRoot = await mkdtemp(join(tmpdir(), 'aios-projects-browser-folders-'));
const child = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('../', import.meta.url),
  env: { ...process.env, AIOS_DATA: data, AIOS_PORT: String(port), AIOS_HOST: '127.0.0.1' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });
const base = `http://127.0.0.1:${port}`;

async function waitReady() {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + '/readyz');
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error('test server not ready: ' + stderr.slice(-1000));
}

let browser;
try {
  await waitReady();
  const path = join(projectRoot, 'delete-me');
  const created = await fetch(base + '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Disposable browser fixture', path }),
  }).then((response) => response.json());

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(base + '/projects');
  const row = `[data-pj-row="${created.id}"]`;
  await page.waitForSelector(row, { timeout: 25_000 });
  await page.click(`${row} [data-pj-delete]`);
  await page.waitForSelector('.pj-delete-card');
  assert.match(await page.textContent('.pj-delete-card'), /Existing session records stay/);
  await page.check('[data-pj-delete-folder]');
  assert.equal(await page.textContent('[data-pj-delete-confirm]'), 'Delete folder + project');
  await page.click('[data-pj-delete-confirm]');
  await page.waitForSelector(row, { state: 'detached' });
  await assert.rejects(stat(path), (error) => error?.code === 'ENOENT',
    'the checked browser action deletes the registered folder as well as its project row');
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
  await rm(projectRoot, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
}

console.log('projects_delete_browser.test ok');
