import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, cp, rm, symlink, lstat, lchmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';

const fixture = await realpath(await mkdtemp(join(tmpdir(), 'aios-archive-test-')));
process.env.AIOS_DATA = join(fixture, 'data');
process.env.AIOS_WORKTREE_ROOT = join(fixture, 'worktrees');
process.env.AIOS_TMUX = '/usr/bin/false';
process.env.AIOS_HOST = '127.0.0.1';
process.env.AIOS_SUMMARY_PORT = '1';
delete process.env.AIOS_NO_LISTEN;
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
process.env.AIOS_PORT = String(probe.address().port);
await new Promise(resolve => probe.close(resolve));
// Exercise the real SSH command/worker protocol locally, without requiring SSH credentials or
// touching Spark in the test suite. No production transport has a bypass switch.
await mkdir(join(fixture, 'bin'));
await writeFile(join(fixture, 'bin', 'ssh'), '#!/bin/sh\nfor arg do command="$arg"; done\nexec /bin/sh -c "$command"\n', { mode: 0o700 });
await writeFile(join(fixture, 'bin', 'sync'), '#!/bin/sh\nexit 0\n', { mode: 0o700 }); // Linux sync -f is not available on macOS fixtures.
process.env.PATH = join(fixture, 'bin') + ':' + process.env.PATH;
const exec = promisify(execFile);
const { archiveWorker, archiveRequest, validateArchiveLocation } = await import('../src/archive_transport.js');
const { archivedFile, archiveRecords } = await import('../src/artifact_archive.js');
const { storedFileInfo, storedFileRead } = await import('../src/stored_file.js');
const local = join(process.env.AIOS_DATA, 'session-artifacts', 's_archive', 'report');
const remote = join(fixture, 'remote', 'artifacts', 's_archive', 'copy');
await mkdir(local, { recursive: true });
await writeFile(join(local, 'index.html'), '<!doctype html><h1>Archived report</h1><script src="app.js"></script>');
await writeFile(join(local, 'app.js'), 'window.fromArchive = true');
await writeFile(join(local, '报告.md'), '# Archived plan\n\nSaved result with evidence.');
await writeFile(join(local, 'audio.wav'), '0123456789');
await writeFile(join(fixture, 'private.txt'), 'not authorized');
await symlink('报告.md', join(local, 'alias.md'));
await symlink(join(local, '报告.md'), join(local, 'absolute-alias.md'));
await mkdir(join(local, 'nested'));
await writeFile(join(local, 'nested', 'entry.html'), '<h1>Narrow scope</h1>');
await symlink('../报告.md', join(local, 'nested', 'outside-folder.md'));
await symlink(join(fixture, 'private.txt'), join(local, 'escape.md'));
await cp(local, remote, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
if (process.platform === 'darwin') {
  await lchmod(join(local, 'alias.md'), 0o755);
  await lchmod(join(remote, 'alias.md'), 0o777); // Actual macOS -> Linux archive semantics.
}
try {
  assert.throws(() => validateArchiveLocation('-oProxyCommand=bad', remote), /Invalid/);
  assert.throws(() => validateArchiveLocation('spark', '/home'), /dedicated/);
  const copySource = join(process.env.AIOS_DATA, 'session-artifacts', 's_copy', 'files');
  await mkdir(copySource, { recursive: true });
  await writeFile(join(copySource, 'executable.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(copySource, 'readable.md'), '# Mode preservation\n', { mode: 0o644 });
  const copyRemote = join(fixture, 'remote', 's_copy', 'files');
  await exec(process.execPath, ['bin/archive-artifacts.mjs', 'copy', 's_copy', 'files', 'fixture', copyRemote],
    { env: process.env, timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal((await lstat(join(copyRemote, 'executable.sh'))).mode & 0o777, 0o755);
  assert.equal((await lstat(join(copyRemote, 'readable.md'))).mode & 0o777, 0o644);
  const before = await archiveWorker({ op: 'digest', root: local });
  const copied = await archiveRequest('fixture', { op: 'digest', root: remote });
  assert.equal(before.digest, copied.digest, 'contents/modes/symlink targets verified');
  assert.equal(before.links, 4, 'symlinks are retained without following external targets');
  await assert.rejects(() => archiveRequest('fixture', { op: 'read', root: remote, path: 'escape.md' }), /escapes/);
  await assert.rejects(() => archiveRequest('fixture', { op: 'stat', root: remote, path: '../private.txt' }), /Invalid/);
  const cli = (op, ...rest) => exec(process.execPath, ['bin/archive-artifacts.mjs', op, 's_archive', 'report', ...rest],
    { env: process.env, timeout: 120_000, maxBuffer: 1024 * 1024 });
  await cli('verify', 'fixture', remote);
  await writeFile(join(local, 'changed.txt'), 'new work');
  await assert.rejects(() => cli('evict'), /Source changed/, 'changed local data must never be evicted');
  await rm(join(local, 'changed.txt'));
  await cli('verify', 'fixture', remote); // refreshed local fingerprint, contents still identical
  await writeFile(join(remote, 'app.js'), 'corrupted remote');
  await assert.rejects(() => cli('evict'), /verification mismatch/, 'remote corruption must never authorize deletion');
  assert.ok((await lstat(local)).isDirectory());
  await writeFile(join(remote, 'app.js'), await readFile(join(local, 'app.js')));
  await cli('evict');
  await assert.rejects(() => lstat(local), { code: 'ENOENT' });
  assert.equal((await archiveRecords({ fresh: true })).find(r => r.sessionId === 's_archive').state, 'archived');
  assert.equal(await archivedFile('s_other', join(local, '报告.md')), null);
  const info = await storedFileInfo('s_archive', join(local, '报告.md'));
  assert.ok(info.archive);
  assert.match((await storedFileRead(join(local, '报告.md'), info, 10000)).toString(), /Archived plan/);
  const alias = await storedFileInfo('s_archive', join(local, 'absolute-alias.md'));
  assert.equal(alias.canonicalTarget, join(local, '报告.md'), 'absolute in-tree links survive cross-host storage');
  await assert.rejects(() => storedFileInfo('s_archive', join(local, 'escape.md')), /unavailable/);

  // Actual HTTP handlers: same paths, same render token, relative assets, Markdown, audio ranges,
  // and source-grounded voice all keep working after local eviction.
  const store = await import('../src/store.js');
  const project = join(fixture, 'project'); await mkdir(project);
  store.createProject({ id: 'p_archive', name: 'Archive fixture', path: project });
  for (const id of ['s_archive', 's_other']) {
    store.createSession({ id, project_id: 'p_archive', tool: 'codex', tmux: `fixture-${id}`, status: 'exited' });
  }
  store.addMessage('s_archive', 'out', 'reply', `Report: ${join(local, 'index.html')} and ${join(local, '报告.md')}`);
  const { featureReady } = await import('../src/server.js'); await featureReady;
  const base = `http://127.0.0.1:${process.env.AIOS_PORT}`;
  const request = (name, extra = '', options) => fetch(`${base}/api/session/s_archive/file?path=${encodeURIComponent(join(local, name))}${extra}`, options);
  const metadataResponse = await request('index.html');
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.storage, 'archive');
  const rendered = await fetch(`${base}/${metadata.renderUrl}`);
  assert.equal(rendered.status, 200);
  assert.match(await rendered.text(), /Archived report/);
  assert.match(rendered.headers.get('content-security-policy'), /sandbox allow-scripts/);
  const script = await fetch(`${base}/${metadata.renderUrl.replace(/index.html$/, 'app.js')}`);
  assert.equal(await script.text(), 'window.fromArchive = true');
  const md = await (await request('报告.md')).json();
  assert.match(await (await fetch(`${base}/${md.renderUrl}`)).text(), /<h1>Archived plan<\/h1>/);
  const nested = await (await request('nested/entry.html')).json();
  const escaping = await fetch(`${base}/${nested.renderUrl.replace(/entry.html$/, 'outside-folder.md')}`);
  assert.equal(escaping.status, 403, 'relative assets cannot use a symlink to escape their granted folder');
  const audio = await request('audio.wav', '&raw=1', { headers: { range: 'bytes=2-5' } });
  assert.equal(audio.status, 206); assert.equal(await audio.text(), '2345');
  const invalidRange = await request('audio.wav', '&raw=1', { headers: { range: 'bytes=99-' } });
  assert.equal(invalidRange.status, 416);
  const { buildVoiceSourcePack } = await import('../src/voice_sources.js');
  const sessions = await import('../src/sessions.js');
  const sources = await buildVoiceSourcePack({ session: store.getSession('s_archive'),
    reportText: `[Plan](${join(local, '报告.md')})`, resolveFile: sessions.resolveSessionFile });
  assert.equal(sources.sources.length, 1);
  assert.match(JSON.stringify(sources), /Saved result/);
  const denied = await fetch(`${base}/api/session/s_other/file?path=${encodeURIComponent(join(local, 'index.html'))}`);
  assert.notEqual(denied.status, 200, 'another session cannot gain archive access');
  await cli('restore');
  assert.equal(await readFile(join(local, 'app.js'), 'utf8'), 'window.fromArchive = true');
  await assert.rejects(() => cli('restore'), /never overwrites/, 'restore cannot replace new local work');
  await cli('verify', 'fixture', remote);
  await cli('evict');
  await renameRemoteAway();
  const offline = await request('index.html');
  assert.equal(offline.status, 503, 'offline archive is not a missing/deleted file');
  console.log('artifact_archive.test ok: verified eviction, retained changes, same URLs, rendered assets, audio ranges, voice grounding, scope, offline');
} finally {
  await rm(fixture, { recursive: true, force: true });
}
process.exit(0);

async function renameRemoteAway() {
  const { rename } = await import('node:fs/promises');
  await rename(remote, remote + '-offline');
}
