// Relocate only untracked, session-owned scratch links (e.g. node_modules).
// Other external links still fail archive validation; never follow arbitrary links.
import { readdir, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';
import { executionGit } from './execution_git.js';
import { expectedStoragePath } from './live_storage.js';

export async function portableWorkingArchive(path, sid, coldFiles = null) {
  const links = [];
  try { await lstat(join(path, '.aios/execution-dependencies')); throw Error('Managed dependency destination already exists; source retained'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const logicalRoot = join(DATA_DIR, 'session-storage', sid);
    const root = await realpath(logicalRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!root) continue;
    if (root !== expectedStoragePath(logicalRoot)) throw Error('Session scratch storage identity changed');
    const target = await realpath(join(path, entry.name));
    if (!target.startsWith(root + '/')) continue; // unchanged external link: validator will refuse it
    // A symlink named node_modules does not match a directory-only ignore rule.
    // Keep its untracked symlink shape while relocating the dependency in-tree.
    const ignored = await executionGit(path, ['check-ignore', '--', entry.name]).then(() => true, error => { if (error.exitCode === 1) return false; throw error; });
    if (!ignored) {
      const tracked = await executionGit(path, ['ls-files', '--error-unmatch', '--', entry.name]).then(() => true, error => { if (error.exitCode === 1) return false; throw error; });
      if (tracked) throw Error('Tracked external dependency links require an explicit project change before migration');
    }
    const info = await lstat(target);
    if (!info.isFile() && !info.isDirectory()) throw Error('Unsupported session dependency');
    links.push({ name: entry.name, path: target, inode: info.ino, device: info.dev,
      localLink: ignored ? null : `.aios/execution-dependencies/${links.length}`,
      rebuild: !!coldFiles?.rebuildDependencies && (entry.name === 'node_modules' || ignored && /\.tsbuildinfo$/.test(entry.name)),
      directory: info.isDirectory() });
  }
  return { command: process.execPath, args: [fileURLToPath(new URL('../bin/execution-export-tree.mjs', import.meta.url)), path,
    Buffer.from(JSON.stringify({ links, excluded: coldFiles?.entries || [] })).toString('base64')], links };
}
