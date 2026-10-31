// Content-addressed application assets. Relative module imports stay inside the same snapshot,
// including lazy views loaded by an already-open tab after a release. HTML/API responses stay fresh.
import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const EXTENSIONS = new Set(['.js', '.mjs', '.css', '.svg', '.png', '.ico', '.woff', '.woff2', '.wasm', '.json']);
const SNAPSHOT = /^assets-v1-([a-f0-9]{24})\.json$/;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 12 * 1024 * 1024;
const hashFiles = files => {
  const hash = createHash('sha256');
  for (const [name, body] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name).update('\0').update(String(body.length)).update('\0').update(body);
  }
  return hash.digest('hex').slice(0, 24);
};

export function assetHtml(html, id) {
  // Preserve document.baseURI: API calls, navigation and manifests are NOT asset URLs.
  return html.replace('<meta name="aios-assets" content=""', `<meta name="aios-assets" content="assets/${id}/"`)
    .replace(/<link\b[^>]*href=['"]https:\/\/fonts\.googleapis\.com\/[^>]+>/gi,
    tag => tag.replace(/rel=['"]stylesheet['"]/i, 'rel="stylesheet" media="print" onload="this.media=\'all\'"'))
    .replace(/\b(src|href)=(['"])([^'"<>]+)\2/g, (all, attr, quote, url) => {
      if (/^(?:[a-z]+:|\/|#)/i.test(url) || !EXTENSIONS.has(extname(url.split(/[?#]/)[0]))) return all;
      return `${attr}=${quote}assets/${id}/${url.replace(/^\.\//, '')}${quote}`;
    });
}

export function createWebAssets({ webDir, cacheDir, keep = 3, maxBytes = MAX_BYTES } = {}) {
  let currentFlight, lastFailure, retryAt = 0;
  const memory = new Map();
  const reads = new Map();
  const remember = snapshot => {
    memory.delete(snapshot.id); memory.set(snapshot.id, snapshot);
    while (memory.size > keep) memory.delete(memory.keys().next().value);
    return snapshot;
  };
  async function prune(current) {
    const entries = [];
    for (const dirent of await readdir(cacheDir, { withFileTypes: true })) {
      // Only our generated immutable snapshots, never originals, directories or symlinks.
      if (!dirent.isFile() || !SNAPSHOT.test(dirent.name)) continue;
      const path = join(cacheDir, dirent.name);
      entries.push({ path, name: dirent.name, mtime: (await stat(path)).mtimeMs });
    }
    entries.sort((a, b) => (b.name === current) - (a.name === current) || b.mtime - a.mtime);
    for (const entry of entries.slice(keep)) await unlink(entry.path);
  }
  async function build() {
    const files = new Map(), pending = []; let bytes = 0;
    async function walk(dir, prefix = '') {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const name = prefix + entry.name, path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path, name + '/');
        else if (entry.isFile() && EXTENSIONS.has(extname(name))) {
          pending.push({ name, path });
        }
      }
    }
    await walk(webDir);
    // Bounded parallel reads also keep isolated candidate builds usable on remote worktrees.
    let next = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (next < pending.length) {
        const { name, path } = pending[next++], body = await readFile(path);
        bytes += body.length;
        if (bytes > maxBytes) throw new Error('Application asset snapshot exceeds its byte budget');
        files.set(name, body);
      }
    }));
    const id = hashFiles(files), snapshot = remember({ id, files, bytes });
    // This small, disposable LOCAL asset cache retains three exact builds for old open tabs.
    // It contains no session data and is capped at 3 * 12 MiB on disk, 3 * 8 MiB in memory.
    const name = `assets-v1-${id}.json`, target = join(cacheDir, name);
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const data = JSON.stringify({ format: 1, id, files: [...files].map(([p, b]) => [p, b.toString('base64')]) });
    if (Buffer.byteLength(data) > MAX_RECORD_BYTES) throw new Error('Application asset record exceeds its byte budget');
    const temp = `${target}.${process.pid}.tmp`;
    try { await writeFile(temp, data, { mode: 0o600 }); await rename(temp, target); }
    finally { await unlink(temp).catch(() => {}); }
    await prune(name);
    return snapshot;
  }
  function current() {
    if (!currentFlight && Date.now() < retryAt) return Promise.reject(lastFailure);
    if (!currentFlight) currentFlight = build().catch(error => {
      currentFlight = null; lastFailure = error; retryAt = Date.now() + 30_000; throw error;
    });
    return currentFlight;
  }
  async function load(id) {
    if (memory.has(id)) return remember(memory.get(id));
    if (!reads.has(id)) reads.set(id, (async () => {
      const path = join(cacheDir, `assets-v1-${id}.json`);
      const st = await stat(path);
      if (!st.isFile() || st.size > MAX_RECORD_BYTES) return null;
      const record = JSON.parse(await readFile(path, 'utf8'));
      if (record.format !== 1 || record.id !== id || !Array.isArray(record.files)) return null;
      const files = new Map(record.files.map(([p, data]) => [p, Buffer.from(data, 'base64')]));
      const bytes = [...files.values()].reduce((n, b) => n + b.length, 0);
      if (bytes > maxBytes || hashFiles(files) !== id) return null;
      return remember({ id, files, bytes });
    })().catch(() => null).finally(() => reads.delete(id)));
    return reads.get(id);
  }
  return {
    current,
    async html(text) { return assetHtml(text, (await current()).id); },
    async get(path) {
      const match = /^\/assets\/([a-f0-9]{24})\/(.+)$/.exec(path);
      if (!match) return null;
      const snapshot = await load(match[1]);
      const body = snapshot?.files.get(match[2]);
      return body ? { body, ext: extname(match[2]), headers: {
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      } } : null;
    },
  };
}
