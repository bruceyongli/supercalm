// Opt-in rebuilding is a transfer policy, not cleanup. Originals stay in place.
import { lstat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { executionGit } from './execution_git.js';

const generatedDirectories = new Set(['node_modules', '.pnpm-store', '.next', '.nuxt', '.vite', '.turbo', '.cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'venv', 'electron-dist', 'dist', 'build', '.wrangler', '.cf-temp', '.vercel']);
export function validateColdBuildPaths(paths = []) {
  if (!Array.isArray(paths) || paths.length > 50 || paths.some(p => typeof p !== 'string' || !p || p.startsWith('/') ||
    /[\\\r\n\0]/.test(p) || p.split('/').some(s => !s || s === '.' || s === '..') || !generatedDirectories.has(posix.basename(p)))) {
    throw Error('Cold build paths must name explicit relative rebuildable directories');
  }
  return [...new Set(paths)];
}
export const coldPathspec = paths => paths.length ? ['--', '.', ...paths.map(p => `:(exclude,literal)${p}`)] : [];

export async function planColdWorkingFiles(root, { coldBuildPaths = [] } = {}) {
  const explicit = validateColdBuildPaths(coldBuildPaths);
  const tracked = (await executionGit(root, ['ls-files', '--cached', '-z'], { maxBytes: 16 * 1024 * 1024 })).split('\0').filter(Boolean);
  const hasTracked = path => tracked.some(p => p === path || p.startsWith(path + '/'));
  const entries = [];
  const add = async (path, reason) => {
    if (hasTracked(path)) {
      if (reason === 'operator-selected-build') throw Error(`Cold build path contains tracked source: ${path}`);
      return;
    }
    const info = await lstat(join(root, path)).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    // External dependency symlinks use the existing scoped relocation path.
    if (!info || info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) return;
    entries.push({ path, source: join(root, path), reason, inode: info.ino, device: info.dev, retained: true });
  };
  for (const path of explicit) await add(path, 'operator-selected-build');
  // Prune explicit large, unignored outputs before asking Git for ignored roots.
  const ignored = (await executionGit(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z',
    ...coldPathspec(entries.map(e => e.path))], { maxBytes: 16 * 1024 * 1024 })).split('\0').filter(Boolean);
  for (const item of ignored) {
    const path = item.replace(/\/$/, ''), base = posix.basename(path);
    if (item.endsWith('/') ? generatedDirectories.has(base) : /\.tsbuildinfo$/.test(base)) await add(path, 'ignored-rebuildable');
  }
  return { version: 1, rebuildDependencies: true, entries };
}
