import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, readlink, symlink, copyFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile), root = await realpath(await mkdtemp(join(tmpdir(), 'aios-dependency-archive-')));
process.env.AIOS_DATA = join(root, 'data');
process.env.AIOS_LIVE_STORAGE_CONFIG = join(root, 'no-storage.json');
try {
  const { prepareDependencyWorkingArchive } = await import('../src/execution_dependency_archive.js');
  const { validateArchive, hashFile, gitEvidence } = await import('../src/execution_bundle.js');
  const repo = join(root, 'repository'), shared = join(root, 'shared-project'), originalRoot = join(root, 'old-worktree');
  await mkdir(repo); await mkdir(shared);
  const git = async (...args) => (await exec('/usr/bin/git', ['-C', repo, ...args])).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(repo, 'plan.md'), 'base'); await git('add', '.'); await git('commit', '-m', 'base');
  await writeFile(join(repo, 'plan.md'), 'staged'); await git('add', 'plan.md'); await writeFile(join(repo, 'plan.md'), 'dirty');
  const head = await git('rev-parse', 'HEAD'), index = join(root, 'copied-index');
  await copyFile(join(repo, '.git/index'), index);
  const policy = { version: 1, allowedSourceRoots: [shared] };
  const fixture = `import tarfile,io,json,sys
with tarfile.open(sys.argv[1],'w',format=tarfile.PAX_FORMAT) as archive:
 for entry in json.loads(sys.argv[2]):
  info=tarfile.TarInfo(entry['path']); info.mode=0o644
  if 'target' in entry:
   info.type=tarfile.SYMTYPE; info.linkname=entry['target']
   if entry.get('pax'): info.pax_headers={'linkpath':entry['target']}
   archive.addfile(info)
  elif entry.get('directory'):
   info.type=tarfile.DIRTYPE; archive.addfile(info)
  else:
   data=entry.get('text','report').encode(); info.size=len(data); archive.addfile(info,io.BytesIO(data))
`;
  let count = 0;
  const create = async entries => {
    const path = join(root, `source-${count++}.tar`);
    await exec('/usr/bin/python3', ['-c', fixture, path, JSON.stringify(entries)]); return path;
  };
  const prepare = archive => prepareDependencyWorkingArchive({ archive, destination: join(root, `derived-${count++}.tar`), repository: repo,
    index, head, sourceRoot: originalRoot, policy });
  const link = { path: './aliyun-deploy/node_modules', target: join(shared, 'aliyun-deploy/node_modules'), pax: true };
  const oldPlaceholder = { path: './.aios/execution-dependencies/0', directory: true };
  const archive = await create([{ path: './plan.md', text: 'dirty' }, oldPlaceholder, link]);
  const receipt = await hashFile(archive), indexReceipt = await hashFile(index);
  await assert.rejects(validateArchive(archive), /External symlink dependency/);
  const prepared = await prepare(archive);
  await validateArchive(prepared.path);
  assert.deepEqual(await hashFile(archive), receipt, 'original received bytes and receipt stay intact');
  assert.deepEqual(await hashFile(index), indexReceipt, 'source index is not refreshed or rewritten');
  assert.equal(prepared.rebuilt.length, 1);
  assert.equal(prepared.rebuilt[0].localTarget, '.aios/execution-rebuilt-dependencies/0');
  await mkdir(join(repo, 'aliyun-deploy'));
  await symlink(link.target, join(repo, 'aliyun-deploy/node_modules'));
  const evidence = await gitEvidence(repo);
  await rm(join(repo, 'aliyun-deploy/node_modules'));
  await exec('/usr/bin/tar', ['-xf', prepared.path, '-C', repo]);
  await writeFile(join(repo, '.git/info/exclude'), '\n/.aios/execution-dependencies/\n/.aios/execution-rebuilt-dependencies/\n');
  assert.equal(await readlink(join(repo, 'aliyun-deploy/node_modules')), '../.aios/execution-rebuilt-dependencies/0');
  assert.ok((await lstat(join(repo, '.aios/execution-rebuilt-dependencies/0'))).isDirectory());
  assert.equal((await gitEvidence(repo)).statusHash, evidence.statusHash, 'untracked symlink shape preserves exact working Git evidence');
  assert.equal(await git('show', ':plan.md'), 'staged'); assert.equal(await readFile(join(repo, 'plan.md'), 'utf8'), 'dirty');

  for (const entry of [
    { ...link, target: '/unapproved/project/node_modules' },
    { ...link, target: join(shared + '-different', 'node_modules') },
    { ...link, target: join(shared, 'source-code') },
    { ...link, path: './source-link' },
  ]) {
    const original = await create([entry]), result = await prepare(original);
    assert.equal(result.path, original); assert.deepEqual(result.rebuilt, []);
    await assert.rejects(validateArchive(result.path), /External symlink dependency/);
  }
  const internal = await create([{ path: './deps/file', text: 'kept' }, { ...link, target: '../deps' }]);
  assert.equal((await prepare(internal)).path, internal, 'in-tree links are never rewritten');
  await assert.rejects(prepare(await create([{ ...oldPlaceholder, path: './.aios/execution-rebuilt-dependencies/0' }, link])), /destination already exists/);
  await assert.rejects(prepare(await create([{ ...link, path: '../node_modules' }])), /Unsafe dependency archive member/);
  const relative = await prepare(await create([{ path: './node_modules', target: '../shared-project/node_modules' }]));
  assert.equal(relative.rebuilt.length, 1); await validateArchive(relative.path);

  // The copied index and HEAD are independent exclusion proofs: neither a staged
  // dependency link nor a HEAD-tracked link staged for deletion may be rebuilt.
  await git('add', 'aliyun-deploy/node_modules'); await copyFile(join(repo, '.git/index'), index);
  await assert.rejects(prepare(archive), /Tracked dependency link cannot be rebuilt/);
  await git('commit', '-m', 'track link');
  const trackedHead = await git('rev-parse', 'HEAD'); await git('rm', '--cached', 'aliyun-deploy/node_modules');
  await copyFile(join(repo, '.git/index'), index);
  await assert.rejects(prepareDependencyWorkingArchive({ archive, destination: join(root, 'must-not-exist.tar'), repository: repo,
    index, head: trackedHead, sourceRoot: originalRoot, policy }), /Tracked dependency link cannot be rebuilt/);
  console.log('execution_dependency_archive: exact node_modules scope, index+HEAD proof, original receipt and Git state preservation passed');
} finally { await rm(root, { recursive: true, force: true }); }
