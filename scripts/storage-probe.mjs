// Explicit native-filesystem probe. Only creates its own fixture; does not migrate user data.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, readlink, lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const [mode, arg] = process.argv.slice(2);
if (!['create', 'verify'].includes(mode) || !arg?.startsWith('/')) throw Error('Usage: storage-probe.mjs create MOUNT | verify FIXTURE');
let fixture = resolve(arg);
if (mode === 'create') {
  fixture = await mkdtemp(join(fixture, '.aios-storage-probe-'));
  await writeFile(join(fixture, 'run.sh'), '#!/bin/sh\nprintf storage-ok\n', { mode: 0o755 });
  await writeFile(join(fixture, 'private.txt'), 'protected', { mode: 0o600 });
  await writeFile(join(fixture, '中文 文件.txt'), '保存文件', { mode: 0o644 });
  await symlink('private.txt', join(fixture, 'relative'));
  await symlink('not-created', join(fixture, 'dangling'));
  await exec('/usr/bin/xattr', ['-w', 'com.aios.storage-probe', 'keep-this-attribute', join(fixture, 'private.txt')]);
  await exec('git', ['init', '-q', fixture]);
  await exec('git', ['-C', fixture, 'add', '.']);
  await mkdir(join(fixture, 'many-files'));
  const start = Date.now();
  for (let i = 0; i < 2000; i++) await writeFile(join(fixture, 'many-files', `${i}.txt`), `probe-${i}`);
  console.log(JSON.stringify({ fixture, files: 2000, writeMs: Date.now() - start }));
}
assert.equal(await realpath(fixture), fixture);
for (const [name, content, mode] of [['run.sh', '#!/bin/sh\nprintf storage-ok\n', 0o755],
  ['private.txt', 'protected', 0o600], ['中文 文件.txt', '保存文件', 0o644]]) {
  assert.equal(await readFile(join(fixture, name), 'utf8'), content);
  assert.equal((await lstat(join(fixture, name))).mode & 0o777, mode);
}
assert.equal(await readlink(join(fixture, 'relative')), 'private.txt');
assert.equal(await readlink(join(fixture, 'dangling')), 'not-created');
assert.equal((await exec('/usr/bin/xattr', ['-p', 'com.aios.storage-probe', join(fixture, 'private.txt')])).stdout.trim(), 'keep-this-attribute');
assert.equal((await exec(join(fixture, 'run.sh'))).stdout, 'storage-ok');
assert.match((await exec('git', ['-C', fixture, 'ls-files', '--stage'])).stdout, /100755 .*run.sh/);
await exec('git', ['-C', fixture, 'fsck', '--no-progress']);
for (let i = 0; i < 2000; i++) assert.equal(await readFile(join(fixture, 'many-files', `${i}.txt`), 'utf8'), `probe-${i}`);
console.log(JSON.stringify({ verified: fixture, content: true, git: true, modes: true, symlinks: true, xattrs: true, executionOnThisHost: true }));
