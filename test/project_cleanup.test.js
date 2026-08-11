import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'aios-project-cleanup-'));
process.env.AIOS_DATA = join(root, 'data');

const store = await import('../src/store.js');
const { cleanupTemporaryProject, removeProject } = await import('../src/project_cleanup.js');

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

try {
  const keepFolder = join(root, 'keep-folder');
  await mkdir(keepFolder);
  store.createProject({ id: 'p_unlist', name: 'Unlist only', path: keepFolder });
  const unlisted = await removeProject('p_unlist');
  assert.equal(unlisted.removed, true);
  assert.equal(unlisted.folderDeleted, false);
  assert.equal(await exists(keepFolder), true, 'default deletion removes only the AIOS project row');

  const deleteFolder = join(root, 'delete-folder');
  await mkdir(deleteFolder);
  await writeFile(join(deleteFolder, 'evidence.txt'), 'fixture');
  store.createProject({ id: 'p_delete', name: 'Delete folder', path: deleteFolder });
  await assert.rejects(
    removeProject('p_delete', { deleteFolder: true, confirmPath: join(root, 'wrong') }),
    (error) => error?.code === 'project-path-confirmation-required'
  );
  assert(store.getProject('p_delete'), 'a failed confirmation leaves the project registered');
  const deleted = await removeProject('p_delete', { deleteFolder: true, confirmPath: deleteFolder });
  assert.equal(deleted.folderDeleted, true);
  assert.equal(await exists(deleteFolder), false, 'explicit folder deletion removes the exact registered directory');

  const temporaryFolder = join(root, 'temporary-folder');
  await mkdir(temporaryFolder);
  store.createProject({
    id: 'p_temp',
    name: 'Temporary fixture',
    path: temporaryFolder,
    lifecycle: 'temporary',
    owner_session_id: 's_parent',
    created_directory: true,
    auto_delete_folder: true,
  });
  store.createSession({ id: 's_child', project_id: 'p_temp', parent_session_id: 's_parent', tool: 'codex', tmux: 'fixture', status: 'working' });
  const live = await cleanupTemporaryProject('p_temp');
  assert.equal(live.reason, 'live-sessions', 'temporary projects stay while any child session is live');
  store.updateSession('s_child', {
    status: 'exited',
    desired_status: 'exited',
    runtime_status: 'exited',
    status_reason: 'expected-completion',
    ended_at: Date.now(),
  });
  const cleaned = await cleanupTemporaryProject('p_temp');
  assert.equal(cleaned.folderDeleted, true);
  assert.equal(store.getProject('p_temp'), undefined, 'finished temporary projects disappear from the project list');
  assert.equal(await exists(temporaryFolder), false, 'AIOS-owned temporary folders are automatically removed');

  const preexistingTemporary = join(root, 'preexisting-temporary');
  await mkdir(preexistingTemporary);
  store.createProject({ id: 'p_temp_existing', name: 'Existing temporary', path: preexistingTemporary, lifecycle: 'temporary', owner_session_id: 's_parent' });
  const existingCleaned = await cleanupTemporaryProject('p_temp_existing');
  assert.equal(existingCleaned.removed, true);
  assert.equal(await exists(preexistingTemporary), true,
    'automatic cleanup unlists an agent-registered existing folder but never guesses that AIOS owns its files');

  store.createProject({ id: 'p_protected', name: 'Protected', path: process.cwd() });
  await assert.rejects(
    removeProject('p_protected', { deleteFolder: true, confirmPath: process.cwd() }),
    (error) => error?.code === 'protected-project-folder'
  );
  assert(store.getProject('p_protected'), 'the running checkout can never be folder-deleted through the API');

  store.createProject({ id: 'p_protected_child', name: 'Protected child', path: join(process.cwd(), 'web') });
  await assert.rejects(
    removeProject('p_protected_child', { deleteFolder: true, confirmPath: join(process.cwd(), 'web') }),
    (error) => error?.code === 'protected-project-folder'
  );
  assert(store.getProject('p_protected_child'), 'folders inside the running checkout are protected too');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('project_cleanup.test ok');
