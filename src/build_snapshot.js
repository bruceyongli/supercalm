// Disposable build inputs, never a second editable worktree. Copy the actual dirty
// files, not HEAD; keep Git administration and ignored bulk/session data out.
import { lstat, readdir, mkdir, readlink, symlink, copyFile, chmod, realpath, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, join, dirname, isAbsolute, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const insideBuildPath = (path, root) => path === root || path.startsWith(root + sep);
export function buildRelativePath(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\0')
      || value.split(/[\\/]/).some(p => p === '..' || p === '.git') || value === '.') {
    throw Error('Build include/output must be a relative path inside the source tree (not .git)');
  }
  return value;
}
async function directory(path) {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  if (!(await lstat(path)).isDirectory()) throw Error('Build destination directory was replaced');
}
export async function buildDirectory(path, root) {
  if (!insideBuildPath(path, root)) throw Error('Build destination escaped its owned root');
  if (path !== root) await buildDirectory(dirname(path), root);
  await directory(path);
}

// Enumerate once, with a byte/file admission bound. Never follow an external
// symlink into another session, a shared dependency store, or the user's home.
export async function buildManifest(root, paths, { maxBytes = Infinity, maxFiles = 250_000, skipMissing = false } = {}) {
  const entries = new Map();
  const parents = new Map();
  let bytes = 0;
  async function visit(name) {
    if (entries.has(name)) return;
    const path = join(root, name);
    // A listed file may be reached through a symlinked ancestor (e.g. --include).
    let info;
    try {
      const parent = dirname(path);
      if (!parents.has(parent)) parents.set(parent, realpath(parent));
      if (!insideBuildPath(await parents.get(parent), root)) throw Error(`Build path escapes source: ${name}`);
      info = await lstat(path);
    }
    catch (e) { if (skipMissing && e.code === 'ENOENT') return; throw e; }
    const entry = { name, mode: info.mode & 0o777, size: info.size, ino: info.ino, dev: info.dev, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
    if (info.isSymbolicLink()) {
      const link = await readlink(path), target = resolve(dirname(path), link);
      if (!insideBuildPath(target, root)) throw Error(`External build symlink is not copied: ${name}`);
      entry.link = relative(dirname(path), target) || '.';
    } else if (info.isDirectory()) entry.directory = true;
    else if (info.isFile()) bytes += info.size;
    else throw Error(`Build input is not a regular file/directory: ${name}`);
    entries.set(name, entry);
    if (bytes > maxBytes || entries.size > maxFiles) throw Error('Build snapshot exceeds its local admission limit');
    if (entry.directory) {
      for (const child of await readdir(path)) {
        if (child === '.git') continue;
        await visit(join(name, child));
      }
    }
  }
  for (const path of paths) await visit(buildRelativePath(path));
  return { entries: [...entries.values()], bytes };
}
export async function copyBuildManifest(source, target, manifest, { check = async () => {}, durable = false } = {}) {
  await buildDirectory(target, target);
  if (durable && process.platform === 'darwin') {
    // Release .app bundles can carry resource forks, xattrs, ACLs and hardlinks.
    // Copy whole selected roots natively rather than losing that metadata or
    // spawning a subprocess for every small file. Never follow external links.
    const names = new Set(manifest.entries.map(e => e.name));
    const roots = manifest.entries.filter(entry => {
      let parent = dirname(entry.name);
      while (parent !== '.') { if (names.has(parent)) return false; parent = dirname(parent); }
      return true;
    });
    const nativeEnv = { ...process.env, DITTOABORT: '1' };
    for (const key of ['DITTONORSRC', 'DITTO_TEST_OPTIONS', 'DITTOKEEPBINARIESPATTERN', 'DITTOKEEPBINARIESDIR']) delete nativeEnv[key];
    for (const entry of roots) {
      await buildDirectory(dirname(join(target, entry.name)), target);
      await exec('/usr/bin/ditto', ['--rsrc', '--extattr', '--qtn', '--acl', join(source, entry.name), join(target, entry.name)],
        { timeout: 20 * 60_000, maxBuffer: 128 * 1024, env: nativeEnv });
    }
    for (const entry of manifest.entries) {
      const src = await lstat(join(source, entry.name)), dst = join(target, entry.name);
      if (src.ino !== entry.ino || src.dev !== entry.dev || src.size !== entry.size
          || src.mtimeMs !== entry.mtimeMs || src.ctimeMs !== entry.ctimeMs) throw Error('Build output changed during publication: ' + entry.name);
      if (entry.link !== undefined && await readlink(dst) !== entry.link) {
        await unlink(dst); await symlink(entry.link, dst);
      } else if (!entry.directory && entry.link === undefined) {
        if ((await lstat(dst)).size !== entry.size) throw Error('Build output copy is incomplete');
        const fd = await open(dst, 'r'); try { await fd.sync(); } finally { await fd.close(); }
      }
    }
    return;
  }
  // Four bounded workers: overlap network waits without flooding a shared mount.
  const files = manifest.entries.filter(e => !e.directory);
  for (const entry of manifest.entries.filter(e => e.directory)) await buildDirectory(join(target, entry.name), target);
  let cursor = 0, failed;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (!failed && cursor < files.length) {
      const entry = files[cursor++];
      try {
        await check();
        const src = join(source, entry.name), dst = join(target, entry.name);
        await buildDirectory(dirname(dst), target);
        const before = await lstat(src);
        if (before.ino !== entry.ino || before.dev !== entry.dev || before.size !== entry.size
            || before.mtimeMs !== entry.mtimeMs || before.ctimeMs !== entry.ctimeMs) throw Error('Build input changed during snapshot: ' + entry.name);
        if (entry.link !== undefined) await symlink(entry.link, dst);
        else {
          await copyFile(src, dst, constants.COPYFILE_EXCL);
          await chmod(dst, entry.mode | 0o200);
          if (durable) { const fd = await open(dst, 'r+'); try { await fd.sync(); } finally { await fd.close(); } }
        }
        const after = await lstat(src);
        if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size
            || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error('Build input changed during copy: ' + entry.name);
      } catch (e) { failed ||= e; }
    }
  }));
  if (failed) throw failed;
}
export async function snapshotBuildSource(source, target, { include = [], maxBytes, check } = {}) {
  const root = await realpath(source);
  if (/\/proxy(?:\/|$)/.test(root)) throw Error('The protected proxy fleet is not a build-job source');
  const opts = { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
  const top = (await exec('git', ['-C', root, 'rev-parse', '--show-toplevel'], opts)).stdout.trim();
  if (await realpath(top) !== root) throw Error('Start the build at the repository root; use cd inside the build command for a subproject');
  const list = (await exec('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], opts)).stdout.split('\0').filter(Boolean);
  const paths = [...new Set(list.filter(n => !n.split('/').includes('.git')))];
  // Installed Node dependencies are normally ignored, but are the hot input we
  // must localize. Other ignored inputs (e.g. .env.production/.venv) are explicit.
  if (await lstat(join(root, 'node_modules')).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) paths.push('node_modules');
  const manifest = await buildManifest(root, paths, { maxBytes, skipMissing: true });
  const extras = await buildManifest(root, include, { maxBytes });
  const all = new Map([...manifest.entries, ...extras.entries].map(e => [e.name, e]));
  const combined = { entries: [...all.values()] };
  combined.bytes = combined.entries.filter(e => !e.directory && e.link === undefined).reduce((sum, e) => sum + e.size, 0);
  if (combined.bytes > maxBytes) throw Error('Build snapshot exceeds its local admission limit');
  await check?.(combined.bytes);
  await copyBuildManifest(root, target, combined, { check });
  return { source: root, files: combined.entries.length, bytes: combined.bytes };
}
