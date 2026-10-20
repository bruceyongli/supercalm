// Storage-only SSH transport. No coding agents or application/database processes run remotely.
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';

export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function validateArchiveLocation(host, root) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(host || '')) throw new Error('Invalid archive SSH host');
  if (!String(root).startsWith('/') || root.split('/').filter(Boolean).length < 4
      || root.split('/').some(p => p === '..' || p === '.') || /[\0\r\n]/.test(root)) {
    throw new Error('Archive destination must be a dedicated absolute directory');
  }
}

// Runs unchanged on either host. Hashes contents, permissions and symlink targets, never follows
// symlinks while inventorying. A separate local fingerprint detects writes during verification.
export async function archiveWorker(request) {
  const fs = await import('node:fs/promises');
  const { createReadStream } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const path = await import('node:path');
  const { pipeline } = await import('node:stream/promises');
  const root = await fs.realpath(request.root);
  if (!(await fs.lstat(request.root)).isDirectory()) throw new Error('Archive root is not a directory');
  if (request.op === 'digest') {
    const hash = createHash('sha256'), fingerprint = createHash('sha256');
    let files = 0, directories = 0, links = 0, bytes = 0;
    async function walk(dir, rel = '') {
      for (const name of (await fs.readdir(dir)).sort()) {
        const full = path.join(dir, name), relative = rel ? `${rel}/${name}` : name;
        const st = await fs.lstat(full);
        fingerprint.update(JSON.stringify([relative, st.ino, st.size, st.mtimeMs, st.ctimeMs]) + '\n');
        let kind, content = '';
        if (st.isSymbolicLink()) { kind = 'link'; content = await fs.readlink(full); links++; }
        else if (st.isDirectory()) { kind = 'dir'; directories++; }
        else if (st.isFile()) {
          kind = 'file'; files++; bytes += st.size;
          if (request.contents !== false) {
            const digest = createHash('sha256');
            for await (const chunk of createReadStream(full)) digest.update(chunk);
            content = digest.digest('hex');
          }
          const after = await fs.lstat(full);
          if (st.ino !== after.ino || st.size !== after.size || st.mtimeMs !== after.mtimeMs || st.ctimeMs !== after.ctimeMs) {
            throw new Error(`File changed during verification: ${relative}`);
          }
        } else throw new Error(`Unsupported archive entry: ${relative}`);
        // macOS commonly reports symlinks as 0755; Linux exposes fixed 0777. Their target,
        // not these nonportable permission bits, controls traversal. Regular modes still match.
        hash.update(JSON.stringify([relative, kind, kind === 'link' ? 0 : st.mode & 0o777, kind === 'file' ? st.size : 0, content]) + '\n');
        if (kind === 'dir') await walk(full, relative);
      }
    }
    await walk(root);
    return { digest: hash.digest('hex'), fingerprint: fingerprint.digest('hex'), files, directories, links, bytes };
  }
  const relative = request.path;
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')
      || relative.split('/').some(p => p === '..' || p === '.')) throw new Error('Invalid archive member');
  let pending = relative.split('/'), target = root, followed = 0;
  while (pending.length) {
    target = path.join(target, pending.shift());
    const entry = await fs.lstat(target);
    if (!entry.isSymbolicLink()) continue;
    if (++followed > 40) throw new Error('Archive symlink loop');
    let link = await fs.readlink(target);
    // Preserve absolute in-tree links without rewriting the verified archive on disk.
    if (path.isAbsolute(link) && request.logicalRoot && link.startsWith(request.logicalRoot + path.sep)) {
      link = path.join(root, path.relative(request.logicalRoot, link));
    }
    const resolved = path.resolve(path.dirname(target), link);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('Archive symlink escapes its root');
    pending = [...path.relative(root, resolved).split('/').filter(Boolean), ...pending];
    target = root;
  }
  target = await fs.realpath(target);
  if (!target.startsWith(root + path.sep)) throw new Error('Archive symlink escapes its root');
  const info = await fs.stat(target);
  if (!info.isFile()) throw new Error('Archive member is not a regular file');
  if (request.op === 'stat') return { size: info.size, mtimeMs: info.mtimeMs, canonicalRelative: path.relative(root, target) };
  if (request.op !== 'read') throw new Error('Invalid archive operation');
  const start = request.start ?? 0, end = request.end ?? Math.max(0, info.size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new Error('Invalid byte range');
  if (info.size && start < info.size) await pipeline(createReadStream(target, { start, end: Math.min(end, info.size - 1) }), process.stdout);
  return null;
}
export const ARCHIVE_WORKER_SOURCE = `(${archiveWorker.toString()})(JSON.parse(Buffer.from(process.argv[1], 'base64'))).then(result => {
  if (result !== null) process.stdout.write(JSON.stringify(result));
}).catch(error => { process.stderr.write(error.message); process.exitCode = 1; });`;

let activeReaders = 0;
const pendingReaders = [];
function drainReaders() {
  while (activeReaders < 4 && pendingReaders.length) pendingReaders.shift()();
}
export function spawnArchiveWorker(host, request, { timeoutMs = 30_000, spawnProcess = spawn } = {}) {
  validateArchiveLocation(host, request.root);
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=3', host,
    `node -e ${shellQuote(ARCHIVE_WORKER_SOURCE)} ${shellQuote(Buffer.from(JSON.stringify(request)).toString('base64'))}`];
  const output = new PassThrough();
  let child = null, detail = '', settled = false, timer;
  const start = () => {
    if (output.destroyed) return;
    activeReaders++;
    clearTimeout(timer);
    child = spawnProcess('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    timer = setTimeout(() => { output.destroy(new Error('Archive storage timed out')); child.kill('SIGKILL'); }, timeoutMs);
    timer.unref();
    child.stderr.on('data', chunk => { detail = (detail + chunk).slice(0, 500); });
    child.stdout.pipe(output, { end: false });
    child.on('error', error => output.destroy(error));
    child.on('close', code => {
      settled = true; clearTimeout(timer); activeReaders--; drainReaders();
      if (code === 0) output.end();
      else output.destroy(new Error(`Archive storage unavailable: ${detail || `SSH exit ${code}`}`));
    });
  };
  timer = setTimeout(() => output.destroy(new Error('Archive storage busy; retry shortly')), 30_000);
  timer.unref();
  output.on('close', () => {
    clearTimeout(timer);
    const index = pendingReaders.indexOf(start);
    if (index >= 0) pendingReaders.splice(index, 1);
    if (child && !settled) child.kill('SIGKILL');
  });
  if (pendingReaders.length >= 64) queueMicrotask(() => output.destroy(new Error('Archive storage busy; retry shortly')));
  else { pendingReaders.push(start); drainReaders(); }
  return output;
}

export async function archiveRequest(host, request, options) {
  const stream = spawnArchiveWorker(host, request, options), parts = [];
  let bytes = 0;
  for await (const part of stream) {
    bytes += part.length;
    if (bytes > 16 * 1024 * 1024) { stream.destroy(); throw new Error('Archive response exceeds limit'); }
    parts.push(part);
  }
  const buffer = Buffer.concat(parts);
  return request.op === 'read' ? buffer : JSON.parse(buffer);
}
