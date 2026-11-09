import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, realpath, writeFile, readFile, symlink, rename, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = await realpath(await mkdtemp(join(tmpdir(), 'aios-cold-preview-')));
const data = join(fixture, 'controller'), project = join(fixture, 'project');
const sid = 's_cold_preview', operation = 'x_cold_preview';
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
Object.assign(process.env, {
  AIOS_DATA: data, AIOS_WORKTREE_ROOT: join(fixture, 'worktrees'), AIOS_TMUX: '/usr/bin/false',
  AIOS_ENV_FILE: join(fixture, 'absent.env'), AIOS_EXECUTION_NODES_FILE: join(fixture, 'absent-nodes.json'),
  AIOS_CODEX_SESSIONS_DIR: join(fixture, 'native'), CLAUDE_CONFIG_DIR: join(fixture, 'claude'),
  AIOS_HOST: '127.0.0.1', AIOS_PORT: String(port), AIOS_SUMMARY_PORT: '1',
  AIOS_LIVE_STORAGE_CONFIG: join(data, 'live-storage.json'),
});
delete process.env.AIOS_EXECUTION_NODE;
delete process.env.AIOS_NO_LISTEN;
let store;
try {
  await mkdir(project);
  // The real archive reader/worker protocol runs against disposable local paths.
  // No SSH credentials, live mounts, worker, or original session data is used.
  const bin = join(fixture, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\nfor arg do command="$arg"; done\nexec /bin/sh -c "$command"\n', { mode: 0o700 });
  process.env.PATH = bin + ':' + process.env.PATH;
  const { featureReady, setExecutionRouter } = await import('../src/server.js');
  await featureReady;
  store = await import('../src/store.js');
  const { routeColdExecutionPreview } = await import('../src/execution_cold_preview.js');
  const { saveArchiveRecord } = await import('../src/artifact_archive.js');
  const { renderedFileMeta } = await import('../src/file_render.js');
  store.createProject({ id: 'p_cold_preview', name: 'Cold preview fixture', path: project });
  for (const id of [sid, 's_cold_other']) {
    store.createSession({ id, project_id: 'p_cold_preview', tool: 'claude', tmux: `fixture-${id}`, status: 'exited' });
    store.updateSession(id, { execution_node: 'bb2', execution_checkout: 1, execution_transfer: id === sid ? operation : 'x_other',
      worktree_path: join(fixture, 'bb2', id), claude_transcript: join(fixture, 'bb2', id + '.jsonl'),
      desired_status: 'exited', runtime_status: 'exited', status_reason: 'operator-stop' });
  }
  const artifacts = join(data, 'session-artifacts', sid);
  const dashboard = join(artifacts, 'dashboard');
  const entry = join(dashboard, 'index.html');
  const uploads = join(project, '.aios', 'attachments', sid);
  const attachment = join(uploads, '123-u_abcdef-screen.png');
  const originalTranscript = join(fixture, 'original-claude.jsonl');
  const originalSession = { ...store.getSession(sid), execution_node: 'local', execution_transfer: null,
    worktree_path: project, claude_transcript: join(fixture, 'old-transcript-location.jsonl') };
  const spec = { session: originalSession, project: store.getProject('p_cold_preview'), artifactsPath: artifacts,
    native: { path: originalTranscript }, artifactCopyPolicy: { version: 3, retainHistoricalArtifacts: true,
      originalsRetained: true, source: artifacts, attachmentsSource: uploads } };
  const updatePolicy = (change = {}, phase = 'complete') => {
    const next = { ...spec, artifactCopyPolicy: { ...spec.artifactCopyPolicy, ...change } };
    store.db.prepare('INSERT OR REPLACE INTO execution_operations VALUES(?,?,?,?,?,?,NULL,?,?)')
      .run(operation, sid, 'bb2', 'move', phase, JSON.stringify({ spec: next }), 1, 1);
  };
  updatePolicy();
  await mkdir(dashboard, { recursive: true });
  await mkdir(uploads, { recursive: true });
  const html = '<!doctype html><h1>Retained dashboard</h1><img src="screen.png"><script src="app.js"></script>';
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  await writeFile(entry, html);
  await writeFile(join(dashboard, 'screen.png'), png);
  await writeFile(join(dashboard, 'app.js'), 'window.coldPreview = true;');
  await writeFile(join(dashboard, 'unmentioned.txt'), 'No exact evidence');
  await writeFile(join(dashboard, 'recording.mp4'), '0123456789');
  await writeFile(attachment, png);
  await writeFile(originalTranscript, JSON.stringify({ type: 'assistant', message: {
    role: 'assistant', content: [{ type: 'text', text: `Report ${entry}\nRecording ${join(dashboard, 'recording.mp4')}` }],
  } }) + '\n');
  const base = `http://127.0.0.1:${port}`;
  const request = (path, extra = '', options) => fetch(`${base}/api/session/${sid}/file?path=${encodeURIComponent(path)}${extra}`,
    { signal: AbortSignal.timeout(10000), ...options });
  // Exercise the production execution router before the diagnostic worker stub.
  // The worker is deliberately unregistered/offline: cold previews must not
  // require its connection, and ordinary worker-owned paths must still fail 503.
  const realRouted = await request(entry);
  assert.equal(realRouted.status, 200, await realRouted.clone().text());
  const realMeta = await realRouted.json();
  assert.equal(await (await fetch(`${base}/${realMeta.renderUrl}`)).text(), html);
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/${realMeta.renderUrl.replace(/index.html$/, 'screen.png')}`)).arrayBuffer()), png);
  assert.equal((await request('worker-output.txt')).status, 503);
  const proxied = [];
  setExecutionRouter(async (req, res, url) => {
    const sessionId = url.pathname.match(/^\/api\/session\/([^/]+)\//)?.[1];
    if (!sessionId) return false;
    if (await routeColdExecutionPreview(req, url, decodeURIComponent(sessionId))) return false;
    proxied.push(url.pathname + url.search);
    res.writeHead(421, { 'content-type': 'text/plain' });
    res.end('Owning worker route');
    return true;
  });
  const result = await request(entry);
  assert.equal(result.status, 200, await result.clone().text());
  const meta = await result.json();
  assert.equal(meta.storage, 'local');
  assert.equal(await (await request(entry, '&raw=1')).text(), html);
  assert.equal(await (await request(`file://localhost${entry}:4`,'&raw=1')).text(), html);
  const download = await request(entry, '&raw=1&download=1');
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.equal(await download.text(), html);
  const open = await request(entry, '&open=1', { redirect: 'manual' });
  assert.equal(open.status, 303);
  assert.equal(open.headers.get('location'), `/aios/${meta.renderUrl}`);
  const render = await fetch(`${base}/${meta.renderUrl}`);
  assert.equal(render.status, 200);
  assert.equal(await render.text(), html);
  assert.match(render.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/${meta.renderUrl.replace(/index.html$/, 'screen.png')}`)).arrayBuffer()), png);
  assert.equal(await (await fetch(`${base}/${meta.renderUrl.replace(/index.html$/, 'app.js')}`)).text(), 'window.coldPreview = true;');
  const media = await request(join(dashboard, 'recording.mp4'), '&raw=1', { headers: { range: 'bytes=2-5' } });
  assert.equal(media.status, 206);
  assert.equal(await media.text(), '2345');
  assert.equal((await request(join(dashboard, 'unmentioned.txt'))).status, 403, 'routing never grants missing exact evidence');
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/api/session/${sid}/attachment/${attachment.split('/').at(-1)}`)).arrayBuffer()), png);
  assert.deepEqual(Buffer.from(await (await request(attachment, '&raw=1')).arrayBuffer()), png);
  await symlink(entry, join(uploads, 'escape.html'));
  assert.equal((await fetch(`${base}/api/session/${sid}/attachment/escape.html`)).status, 403,
    'the legacy attachment route cannot bypass upload realpath confinement');
  assert.equal((await fetch(`${base}/api/session/${sid}/attachment/new-worker-upload.png`)).status, 421,
    'new attachments remain on the owning worker');
  assert.equal((await request(join(fixture, 'bb2/data/session-artifacts', sid, 'new.png'))).status, 421);
  assert.equal((await request('report.md')).status, 421, 'relative project paths remain on the worker');
  assert.equal((await request(join(data, 'session-artifacts', 's_cold_other', 'other.png'))).status, 421);
  assert.equal((await fetch(`${base}/${meta.renderUrl.replace(sid, 's_cold_other')}`)).status, 421,
    'a token is never borrowed across sessions');
  const workerGrant = renderedFileMeta(sid, join(fixture, 'bb2', sid, 'worker.html'), 1);
  assert.equal((await fetch(`${base}/${workerGrant.renderUrl}`)).status, 421, 'worker entries stay on the worker');
  assert.equal((await request(entry, '', { method: 'POST' })).status, 421, 'cold routing is read-only');
  for (const change of [{ version: 2 }, { originalsRetained: false }, { retainHistoricalArtifacts: false }, { source: join(data, 'session-artifacts') }]) {
    updatePolicy(change);
    assert.equal((await request(entry)).status, 421, 'ineligible/malformed policy is not authority');
  }
  updatePolicy({}, 'cancelled');
  assert.equal((await request(entry)).status, 421, 'cancelled transfers never enable cold routing');
  updatePolicy({}, 'activating');
  assert.equal((await request(entry)).status, 200, 'ownership committed before activation still permits originals');
  updatePolicy();
  const shadow = store.getSession(sid);
  assert.equal(shadow.execution_node, 'bb2');
  assert.equal(shadow.claude_transcript, join(fixture, 'bb2', sid + '.jsonl'), 'evidence restore never changes the shadow row');
  assert.equal(await readFile(entry, 'utf8'), html, 'preview never modifies original files');

  const archivedRoot = join(artifacts, 'archived-report');
  const remoteRoot = join(fixture, 'remote', sid, 'report');
  await mkdir(remoteRoot, { recursive: true });
  await writeFile(join(remoteRoot, 'index.html'), html);
  await writeFile(join(remoteRoot, 'screen.png'), png);
  await saveArchiveRecord({ sessionId: sid, sourceRoot: archivedRoot, host: 'fixture', remoteRoot,
    digest: 'a'.repeat(64), bytes: Buffer.byteLength(html) + png.length, state: 'archived' });
  const archivedResponse = await request(join(archivedRoot, 'index.html'));
  assert.equal(archivedResponse.status, 200);
  const archivedMeta = await archivedResponse.json();
  assert.equal(archivedMeta.storage, 'archive');
  assert.equal(await (await fetch(`${base}/${archivedMeta.renderUrl}`)).text(), html);
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/${archivedMeta.renderUrl.replace(/index.html$/, 'screen.png')}`)).arrayBuffer()), png);
  await assert.rejects(lstat(archivedRoot), { code: 'ENOENT' }, 'archive previews do not hydrate local storage');
  await rename(remoteRoot, remoteRoot + '-offline');
  assert.equal((await request(join(archivedRoot, 'index.html'))).status, 503, 'unavailable originals are retryable, not deleted');

  // Physical Spark links are recognized only through the existing registered
  // storage mapping; no arbitrary filesystem alias is added to file scope.
  const source = join(data, 'session-artifacts'), mount = join(fixture, 'mounts', 'spark'), physical = join(mount, 'artifacts');
  await mkdir(mount, { recursive: true });
  await rename(source, physical);
  await symlink(physical, source);
  await writeFile(process.env.AIOS_LIVE_STORAGE_CONFIG, JSON.stringify({ version: 1, id: 'preview-fixture', mount,
    mappings: [{ source, target: physical, active: true }] }));
  const physicalEntry = join(physical, sid, 'dashboard', 'index.html');
  assert.equal(await (await request(physicalEntry, '&raw=1')).text(), html);
  assert.equal(await (await fetch(`${base}/${meta.renderUrl}`)).text(), html);
  assert.ok(proxied.length > 0);
  console.log('execution_cold_preview.test ok: exact original routing, original native evidence, source/download, HTML relative assets, archive/offline, uploads, no hydration, no worker/new-output or scope widening');
} finally {
  store?.db.close();
  await rm(fixture, { recursive: true, force: true });
}
process.exit(0);
