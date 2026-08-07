import { lstat, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { DATA_DIR, ROOT } from './config.js';
import * as store from './store.js';

const cleanupFlights = new Map();

function cleanupError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function inside(path, root) {
  return path === root || path.startsWith(root + sep);
}

function protectsService(path) {
  const home = resolve(homedir());
  const service = resolve(ROOT);
  const data = resolve(DATA_DIR);
  const proxy = resolve(join(homedir(), 'proxy'));
  const tempRoot = resolve(tmpdir());
  // Never delete a broad ancestor that contains the service/data, the home/temp root itself, or
  // anything in the operator's explicitly off-limits proxy fleet. Registered child folders are fine.
  return path === resolve(sep)
    || path === home
    || path === tempRoot
    || inside(service, path)
    || inside(path, service)
    || inside(data, path)
    || inside(path, data)
    || inside(path, proxy);
}

async function removeRegisteredFolder(project) {
  const stored = String(project?.path || '');
  if (!isAbsolute(stored)) throw cleanupError('registered project path is not absolute', 'unsafe-project-folder');
  const target = resolve(stored);
  if (protectsService(target)) {
    throw cleanupError('this folder is protected and can only be removed outside AIOS', 'protected-project-folder', 409);
  }
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return { folderDeleted: false, folderMissing: true };
    throw cleanupError(`cannot inspect project folder: ${error.message || error}`, 'project-folder-unavailable', 409);
  }
  // Refuse symlinks: recursive deletion must always target the exact registered directory, never a
  // path whose meaning depends on link resolution.
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw cleanupError('project folder deletion requires a real directory, not a symlink or file', 'unsafe-project-folder', 409);
  }
  const canonical = await realpath(target).catch(() => '');
  if (!canonical || protectsService(canonical)) {
    throw cleanupError('project folder resolved to a protected path', 'unsafe-project-folder', 409);
  }
  await rm(canonical, { recursive: true, force: false, maxRetries: 2 });
  return { folderDeleted: true, folderMissing: false };
}

export async function removeProject(projectId, {
  deleteFolder = false,
  confirmPath = '',
  automatic = false,
} = {}) {
  if (cleanupFlights.has(projectId)) return cleanupFlights.get(projectId);
  const operation = (async () => {
    const project = store.getProject(projectId);
    if (!project) {
      if (automatic) return { ok: true, removed: false, reason: 'missing' };
      throw cleanupError('no such project', 'project-not-found', 404);
    }
    if (automatic && project.lifecycle !== 'temporary') return { ok: true, removed: false, reason: 'persistent' };
    if (store.liveSessionsForProject(projectId) > 0) {
      if (automatic) return { ok: true, removed: false, reason: 'live-sessions' };
      throw cleanupError('project has live sessions — stop them first', 'project-has-live-sessions', 409);
    }

    const removeFolder = automatic
      ? !!(project.created_directory && project.auto_delete_folder)
      : !!deleteFolder;
    if (removeFolder && !automatic && String(confirmPath || '') !== String(project.path || '')) {
      throw cleanupError('folder deletion requires the exact registered path confirmation', 'project-path-confirmation-required', 409);
    }

    const previousLifecycle = project.lifecycle || 'persistent';
    store.setProjectLifecycle(projectId, 'deleting');
    try {
      const folder = removeFolder
        ? await removeRegisteredFolder(project)
        : { folderDeleted: false, folderMissing: false };
      store.deleteProject(projectId);
      return { ok: true, removed: true, project: { id: project.id, name: project.name, path: project.path }, ...folder };
    } catch (error) {
      if (store.getProject(projectId)) store.setProjectLifecycle(projectId, previousLifecycle);
      throw error;
    }
  })().finally(() => cleanupFlights.delete(projectId));
  cleanupFlights.set(projectId, operation);
  return operation;
}

export function cleanupTemporaryProject(projectId) {
  return removeProject(projectId, { automatic: true });
}

export async function sweepTemporaryProjects() {
  const results = [];
  for (const project of store.listProjects()) {
    if (project.lifecycle !== 'temporary') continue;
    try { results.push(await cleanupTemporaryProject(project.id)); }
    catch (error) { results.push({ ok: false, project: project.id, error: String(error.message || error) }); }
  }
  return results;
}
