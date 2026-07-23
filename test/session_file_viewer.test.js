import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILE_REFERENCE_RX, localFilePath } from '../web/file-reference.js';

// Full URLs printed by an agent on this host map back to their local absolute path. Other hosts never
// do, and the terminal matcher keeps the full URL as one link instead of dropping the "https:" prefix.
{
  const host = 'bb1.taileabe0b.ts.net';
  const full = `https://${host}/tmp/mo-journey/prod-workflows.png`;
  assert.equal(localFilePath(full, host), '/tmp/mo-journey/prod-workflows.png');
  assert.equal(localFilePath('//bb1.taileabe0b.ts.net/tmp/report.md', host), '/tmp/report.md');
  assert.equal(localFilePath('docs/report.md', host), 'docs/report.md');
  assert.equal(localFilePath('https://elsewhere.test/tmp/secret.txt', host), '');
  FILE_REFERENCE_RX.lastIndex = 0;
  assert.equal(FILE_REFERENCE_RX.exec(`result: ${full}`)?.[0], full);
}

const scratch = await mkdtemp(join(tmpdir(), 'aios-session-files-'));
const projectRoot = join(scratch, 'project');
const artifactRoot = join(scratch, 'artifacts');
await mkdir(projectRoot);
await mkdir(artifactRoot);
await writeFile(join(projectRoot, 'report.md'), '# Project report\n');
const artifact = join(artifactRoot, 'result.png');
const privateArtifact = join(artifactRoot, 'private.txt');
await writeFile(artifact, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
await writeFile(privateArtifact, 'not mentioned by this session');
await symlink(privateArtifact, join(projectRoot, 'escape.txt'));

process.env.AIOS_DATA = join(scratch, 'data');
const port = 31000 + Math.floor(Math.random() * 7000);
process.env.AIOS_PORT = String(port);

const store = await import('../src/store.js');
store.createProject({ id: 'p_files', name: 'files', path: projectRoot });
store.createSession({ id: 's_files', project_id: 'p_files', tool: 'codex', tmux: 'tmx_files', status: 'exited' });
store.addMessage('s_files', 'out', 'reply', `Generated image: ${artifact}`);
await import('../src/server.js');

const base = `http://127.0.0.1:${port}`;
async function fileRequest(path, suffix = '') {
  return fetch(`${base}/api/session/s_files/file?path=${encodeURIComponent(path)}${suffix}`);
}
async function waitForRoutes() {
  for (let i = 0; i < 100; i++) {
    const response = await fileRequest('report.md').catch(() => null);
    if (response?.headers.get('content-type')?.includes('application/json')) return response;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('session file route did not load');
}

// Project files retain the original viewer behavior.
{
  const response = await waitForRoutes();
  assert.equal(response.status, 200);
  const meta = await response.json();
  assert.equal(meta.path, 'report.md');
  assert.equal(meta.contentKind, 'text');
}

// A session-mentioned temp artifact can be previewed and served raw.
{
  const response = await fileRequest(artifact);
  assert.equal(response.status, 200);
  const meta = await response.json();
  assert.equal(meta.path, artifact);
  assert.equal(meta.contentKind, 'image');
  const raw = await fetch(`${base}/${meta.viewUrl}`);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get('content-type'), 'image/png');
  assert.equal((await raw.arrayBuffer()).byteLength, 8);
  const missing = join(artifactRoot, 'not-written-yet.md');
  store.addMessage('s_files', 'out', 'reply', `Pending report: ${missing}`);
  assert.equal((await fileRequest(missing)).status, 404);
}

// Temp files not present in session evidence stay private. Project symlinks cannot escape the project
// root into that temp area either.
{
  store.addMessage('s_files', 'out', 'reply', `Different artifact: ${privateArtifact}.backup`);
  assert.equal((await fileRequest(privateArtifact)).status, 403);
  assert.equal((await fileRequest('escape.txt')).status, 403);
}

// Story markdown links are delegated into the same viewer instead of opening the host root in a tab.
{
  const src = readFileSync(new URL('../web/session.js', import.meta.url), 'utf8');
  assert.match(src, /story-body\.md a\[href\]/);
  assert.match(src, /localFilePath\(link\.getAttribute\('href'\)\)/);
  assert.match(src, /openFileViewer\(path\)/);
}

console.log('session_file_viewer.test ok');
process.exit(0);
