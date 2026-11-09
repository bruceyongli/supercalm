import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), 'aios-archive-reports-')));
process.env.AIOS_DATA = join(root, 'data');
process.env.AIOS_WORKTREE_ROOT = join(root, 'worktrees');
process.env.AIOS_LIVE_STORAGE_CONFIG = join(root, 'no-storage.json');
try {
  const { archivedWorkingArchive, executionArtifactArchives } = await import('../src/execution_archive.js');
  const { saveArchiveRecord, archivedFile, archiveIndexRoot, archiveRecordId } = await import('../src/artifact_archive.js');
  const { archiveWorker } = await import('../src/archive_transport.js');
  const { validateArchive } = await import('../src/execution_bundle.js');
  const remote = join(root, "remote/reports with 'quotes'");
  await mkdir(remote, { recursive: true });
  const keep = ['report.md', 'notes.markdown', 'summary.txt', 'index.html', 'detail.htm', 'table.csv', 'table.tsv',
    'conclusion.rst', 'conclusion.adoc', 'conclusion.asciidoc', 'UPPER.MD', 'debug/report.md', 'ordinary/venv/report.md',
    "nested/- report 'quoted'.md"];
  const cold = ['screenshot.png', 'movie.mp4', 'debug.log', 'debug.json', 'debug.jsonl', 'report.pdf', 'archive.zip',
    'node_modules/package/README.md', '.venv/pyvenv.cfg', '.venv/report.md', 'venv/pyvenv.cfg', 'venv/report.md',
    'Desktop.app/Contents/Info.plist', 'Desktop.app/Contents/README.md'];
  for (const name of [...keep, ...cold]) {
    await mkdir(dirname(join(remote, name)), { recursive: true });
    await writeFile(join(remote, name), `original ${name}\n`);
  }
  const outside = join(root, 'outside');
  await mkdir(outside); await writeFile(join(outside, 'secret.md'), 'outside data');
  await symlink(outside, join(remote, 'outside'));
  await symlink(join(outside, 'secret.md'), join(remote, 'external.md'));
  await symlink('report.md', join(remote, 'linked-report.md'));
  const sessionId = 's_reports', sourceRoot = join(process.env.AIOS_DATA, 'session-artifacts', sessionId, 'evidence');
  const totals = await archiveWorker({ root: remote, op: 'digest', contents: false });
  const record = { ...totals, sessionId, sourceRoot, host: 'fixture', remoteRoot: remote, state: 'archived' };
  await saveArchiveRecord(record);
  const indexFile = join(archiveIndexRoot, `${archiveRecordId(sourceRoot)}.json`), indexBefore = await readFile(indexFile, 'utf8');
  const policy = { retainHistoricalArtifacts: true };
  const descriptor = archivedWorkingArchive(record, policy);
  assert.equal(descriptor.command, '/usr/bin/ssh');
  assert.equal(descriptor.args.at(-2), 'fixture');
  assert.match(descriptor.args.at(-1), /^python3 -c /);
  assert.match(archivedWorkingArchive(record).args.at(-1), /^tar /, 'full transfer stays the default');
  assert.equal(archivedWorkingArchive({ ...record, kind: 'worktree' }, policy).args.at(-1),
    archivedWorkingArchive({ ...record, kind: 'worktree' }).args.at(-1), 'exact worktree transfer is unchanged');
  // Execute the exact generated SSH command locally, including shell quoting.
  const output = await exec('/bin/sh', ['-c', descriptor.args.at(-1)], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
  const tar = join(root, 'reports.tar'); await writeFile(tar, output.stdout);
  await validateArchive(tar, { allowGit: true });
  const members = (await exec('/usr/bin/tar', ['-tf', tar])).stdout.trim().split('\n').map(name => name.replace(/^\.\//, '')).sort();
  assert.deepEqual(members, keep.slice().sort(), 'only regular allowlisted reports are transferred');
  for (const name of [...keep, ...cold]) assert.equal(await readFile(join(remote, name), 'utf8'), `original ${name}\n`);
  assert.equal(await readFile(indexFile, 'utf8'), indexBefore, 'archive registration is never rewritten');
  assert.equal((await executionArtifactArchives(sessionId))[0].remoteRoot, remote);
  assert.equal((await archivedFile(sessionId, join(sourceRoot, 'screenshot.png'))).remoteRoot, remote,
    'cold media remains reachable through the original archive registration');

  const alias = join(root, 'remote/linked-root'); await symlink(remote, alias);
  await assert.rejects(exec('/bin/sh', ['-c', archivedWorkingArchive({ ...record, remoteRoot: alias }, policy).args.at(-1)]),
    /Too many levels|Not a directory/, 'a symlink root cannot redirect the transfer');
  const unsafe = join(root, 'remote/unsafe'); await mkdir(unsafe);
  await writeFile(join(unsafe, 'bad\\name.md'), 'bad');
  await assert.rejects(exec('/bin/sh', ['-c', archivedWorkingArchive({ ...record, remoteRoot: unsafe }, policy).args.at(-1)]),
    /Unsafe report archive member/);
  // Deterministically mutate a selected file after tar consumes it. The command
  // must fail even though the stream already contains a complete tar member.
  const changed = descriptor.args.at(-1).replace('archive.addfile(info,stream)',
    'archive.addfile(info,stream); os.utime(stream.fileno(),ns=(0,0))');
  await assert.rejects(exec('/bin/sh', ['-c', changed], { encoding: 'buffer' }), /Report changed during transfer/);
  console.log('execution_archive_reports: report-only SSH tar, source stability, symlink boundaries and cold archive registration passed');
} finally { await rm(root, { recursive: true, force: true }); }
