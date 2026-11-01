// Vite's public -> dist copies otherwise read AND write every media byte over
// a network-backed APFS image. Some macOS Node/libuv builds return ENOSYS for
// COPYFILE_FICLONE_FORCE even though /bin/cp -c can clone the very same file.
// This preload is limited to build commands and new public-asset destinations.
// Originals are NEVER hardlinked to outputs. An independent native copy is
// linked into place exclusively; existing files/links retain Node semantics.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { homedir } from 'node:os';

const exec = promisify(execFile), minimumBytes = 128 * 1024;
const inside = (path, root) => path.startsWith(root + sep);
const pathString = value => typeof value === 'string' ? resolve(value) : value instanceof URL && value.protocol === 'file:' ? fileURLToPath(value) : null;
const copyOptions = { timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };

export function installBuildAssetCopies(sourceRoot, { nativeSync = execFileSync, nativeAsync = exec, localDevice } = {}) {
  if (process.platform !== 'darwin' || !sourceRoot) return { restore() {}, stats: {} };
  const original = { sync: fs.copyFileSync, callback: fs.copyFile, promise: fsp.copyFile };
  const stats = { nativeCopies: 0, nativeBytes: 0, fallbacks: 0 };
  localDevice ??= fs.statSync(homedir()).dev;
  // A network-backed image can stall even on a 1 KiB file. Native copy is worth
  // its process overhead there; on the local disk keep small copies in Node.
  const worthCopying = info => info.size >= minimumBytes || info.dev !== localDevice;
  // Resolve lazily: the many build checks that never copy an asset do no mount IO.
  let roots;
  function pair(src, dst, mode) {
    try {
      if (mode !== undefined && mode !== 0 && mode !== fs.constants.COPYFILE_EXCL) return null;
      const from = pathString(src), to = pathString(dst);
      if (!from || !to) return null;
      roots ||= [...new Set([resolve(sourceRoot), fs.realpathSync(sourceRoot)])];
      if (roots.some(root => /\/proxy(?:\/|$)/.test(root))) return null;
      for (const root of roots) {
        if (!inside(from, root) || !inside(to, root)) continue;
        const input = relative(root, from).split(sep), output = relative(root, to).split(sep);
        const publicIndex = input.lastIndexOf('public');
        if (publicIndex < 0 || input.some(p => ['.git', 'node_modules', 'proxy'].includes(p))) continue;
        if (!['dist', 'build', 'out'].includes(output[publicIndex])) continue;
        const expected = [...input]; expected[publicIndex] = output[publicIndex];
        if (expected.join(sep) === output.join(sep)) return { from, to, root: roots.at(-1) };
      }
    } catch { /* The original API owns validation/errors, not this optimization. */ }
    return null;
  }
  function valid(info, parent, from, to, item) {
    return info.isFile() && worthCopying(info) && info.dev === parent.dev
      && inside(from, item.root) && inside(to, item.root);
  }
  function accepted(info) { stats.nativeCopies++; stats.nativeBytes += info.size; }
  fs.copyFileSync = function (src, dst, mode) {
    const item = pair(src, dst, mode);
    if (!item) return original.sync(src, dst, mode);
    let info;
    try {
      info = fs.lstatSync(item.from);
      if (!info.isFile() || !worthCopying(info)) info = null;
      if (info) {
        const parent = dirname(item.to);
        if (!valid(info, fs.statSync(parent), fs.realpathSync(item.from), fs.realpathSync(parent), item)) info = null;
        try { fs.lstatSync(item.to); info = null; }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    } catch { info = null; }
    if (!info) return original.sync(src, dst, mode);
    let stage;
    try {
      stage = fs.mkdtempSync(join(dirname(item.to), '.aios-asset-copy-'));
      const copy = join(stage, 'asset');
      nativeSync('/bin/cp', ['-c', item.from, copy], copyOptions);
      const copied = fs.lstatSync(copy);
      if (!copied.isFile() || copied.size !== info.size || copied.ino === info.ino) throw Error('Incomplete or shared asset copy');
      fs.chmodSync(copy, info.mode & 0o777);
      fs.linkSync(copy, item.to); // atomic/exclusive; never overwrite a racing writer
      accepted(info);
      return;
    } catch { stats.fallbacks++; }
    finally { if (stage) fs.rmSync(stage, { recursive: true, force: true }); }
    return original.sync(src, dst, mode);
  };
  // Bound async native processes; a bundler's Promise.all must not spawn a
  // process per asset at once. Synchronous Vite copies are naturally serial.
  let active = 0;
  const waiting = [];
  async function copyAsync(src, dst, mode) {
    const item = pair(src, dst, mode);
    if (!item) return original.promise(src, dst, mode);
    await new Promise(ok => { if (active < 4) { active++; ok(); } else waiting.push(ok); });
    let stage;
    let attempted = false;
    try {
      const info = await fsp.lstat(item.from), parent = dirname(item.to);
      const eligible = info.isFile() && worthCopying(info);
      const dest = eligible && await fsp.lstat(item.to).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (eligible && !dest && valid(info, await fsp.stat(parent), await fsp.realpath(item.from), await fsp.realpath(parent), item)) {
        attempted = true;
        stage = await fsp.mkdtemp(join(parent, '.aios-asset-copy-'));
        const copy = join(stage, 'asset');
        await nativeAsync('/bin/cp', ['-c', item.from, copy], copyOptions);
        const copied = await fsp.lstat(copy);
        if (!copied.isFile() || copied.size !== info.size || copied.ino === info.ino) throw Error('Incomplete or shared asset copy');
        await fsp.chmod(copy, info.mode & 0o777);
        await fsp.link(copy, item.to);
        accepted(info);
        return;
      }
    } catch { if (attempted) stats.fallbacks++; }
    finally {
      try { if (stage) await fsp.rm(stage, { recursive: true, force: true }); }
      finally { const next = waiting.shift(); if (next) next(); else active--; }
    }
    return original.promise(src, dst, mode);
  }
  fsp.copyFile = copyAsync;
  fs.copyFile = function (src, dst, mode, callback) {
    if (typeof mode === 'function') { callback = mode; mode = undefined; }
    if (typeof callback !== 'function' || !pair(src, dst, mode)) return original.callback(src, dst, mode, callback);
    copyAsync(src, dst, mode).then(() => callback(null), callback);
  };
  syncBuiltinESMExports();
  return { stats, restore() {
    fs.copyFileSync = original.sync; fs.copyFile = original.callback; fsp.copyFile = original.promise;
    syncBuiltinESMExports();
  } };
}
const automatic = process.env.AIOS_BUILD_COPY_ROOT && process.env.AIOS_BUILD_FAST_COPY !== '0'
  ? installBuildAssetCopies(process.env.AIOS_BUILD_COPY_ROOT) : null;
export const buildAssetCopyStats = () => automatic ? { ...automatic.stats } : null;
