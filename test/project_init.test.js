import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { normalizeProjectPath, prepareProjectDirectory } from '../src/project_init.js';

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'aios-project-init-'));

try {
  const missing = join(root, 'parent', 'new-project');
  const created = await prepareProjectDirectory(missing);
  assert.deepEqual(created, {
    path: missing,
    createdDirectory: true,
    initializedGit: true,
  });
  assert.equal((await stat(join(missing, '.git'))).isDirectory(), true, 'new project is a Git repository');
  const branch = await exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: missing, encoding: 'utf8' });
  assert.equal(branch.stdout.trim(), 'main', 'new repository starts on main');

  const existing = join(root, 'existing-folder');
  await mkdir(existing);
  const untouched = await prepareProjectDirectory(existing);
  assert.equal(untouched.createdDirectory, false);
  assert.equal(untouched.initializedGit, false);
  await assert.rejects(stat(join(existing, '.git')), (error) => error?.code === 'ENOENT',
    'an existing non-Git folder is never converted implicitly');

  const file = join(root, 'not-a-folder');
  await writeFile(file, 'fixture');
  await assert.rejects(prepareProjectDirectory(file), (error) =>
    error?.code === 'project-path-not-directory' && /not a directory/.test(error.message));
  assert.throws(() => normalizeProjectPath('relative/project'), (error) =>
    error?.code === 'invalid-project-path' && /absolute/.test(error.message));

  const failedGit = join(root, 'git-failure');
  await assert.rejects(
    prepareProjectDirectory(failedGit, { gitBin: join(root, 'missing-git-binary') }),
    (error) => error?.code === 'project-git-init-failed' && /folder was created/.test(error.message)
  );
  assert.equal((await stat(failedGit)).isDirectory(), true,
    'a Git failure reports the created folder and does not destructively remove it');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('project_init.test ok');
