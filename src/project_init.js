import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { isAbsolute, resolve } from 'node:path';

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = Number(process.env.AIOS_PROJECT_GIT_INIT_TIMEOUT_MS || 15_000);

function projectPathError(message, code = 'invalid-project-path', cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export function normalizeProjectPath(value) {
  const raw = String(value || '').trim();
  if (!raw) throw projectPathError('project path is required');
  if (!isAbsolute(raw)) {
    throw projectPathError('path must be absolute (e.g. /home/you/code/project)');
  }
  return resolve(raw);
}

// Prepare a path before its project row is persisted. Existing directories are deliberately untouched:
// users may add workspaces or non-Git folders. Only a directory created by this request is initialized.
export async function prepareProjectDirectory(value, { gitBin = process.env.AIOS_GIT_BIN || 'git' } = {}) {
  const path = normalizeProjectPath(value);
  let existing = null;
  try {
    existing = await stat(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw projectPathError(`cannot inspect project path: ${error.message || error}`, 'project-path-unavailable', error);
    }
  }

  if (existing) {
    if (!existing.isDirectory()) {
      throw projectPathError('project path exists but is not a directory', 'project-path-not-directory');
    }
    return { path, createdDirectory: false, initializedGit: false };
  }

  let firstCreated;
  try {
    firstCreated = await mkdir(path, { recursive: true });
  } catch (error) {
    throw projectPathError(`could not create project folder: ${error.message || error}`, 'project-folder-create-failed', error);
  }

  // mkdir({recursive:true}) returns undefined if another request won the race. Do not initialize a
  // directory we did not create; this keeps the "existing directories are untouched" contract exact.
  if (firstCreated === undefined) {
    const raced = await stat(path).catch(() => null);
    if (!raced?.isDirectory()) throw projectPathError('project folder was not created', 'project-folder-create-failed');
    return { path, createdDirectory: false, initializedGit: false };
  }

  try {
    await exec(gitBin, ['init', '--initial-branch=main'], {
      cwd: path,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).replace(/\s+/g, ' ').trim().slice(0, 300);
    throw projectPathError(
      `project folder was created, but Git initialization failed${detail ? `: ${detail}` : ''}`,
      'project-git-init-failed',
      error
    );
  }

  return { path, createdDirectory: true, initializedGit: true };
}
