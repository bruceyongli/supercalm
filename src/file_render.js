// Read-only, directory-scoped artifact hosting. A rendered document gets an
// opaque browser origin, including when opened directly in a new tab.
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, isAbsolute } from 'node:path';
import { db } from './store.js';
import { renderMarkdown, escapeHtml } from '../web/common.js';
import { isFileReference, localFilePath } from '../web/file-reference.js';
import { archivedFile } from './artifact_archive.js';
import { storedFileInfo, storedFileRead, storedFileStream } from './stored_file.js';
import { logicalStoragePath, sameStoragePath } from './live_storage.js';

db.exec(`CREATE TABLE IF NOT EXISTS file_render_grants (
  token TEXT PRIMARY KEY, session_id TEXT NOT NULL, entry_path TEXT NOT NULL,
  UNIQUE(session_id, entry_path)
)`);
const types = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.md': 'text/html; charset=utf-8', '.markdown': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.csv': 'text/plain', '.tsv': 'text/plain', '.txt': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
export function renderedFileMeta(sessionId, target, bytes = 0) {
  if (!/\.(?:html?|md|markdown|svg)$/i.test(target)) return {};
  target = logicalStoragePath(target);
  let grant = db.prepare('SELECT token FROM file_render_grants WHERE session_id=? AND entry_path=?').get(sessionId, target);
  if (!grant) {
    const token = randomBytes(24).toString('hex');
    db.prepare('INSERT OR IGNORE INTO file_render_grants VALUES (?,?,?)').run(token, sessionId, target);
    grant = db.prepare('SELECT token FROM file_render_grants WHERE session_id=? AND entry_path=?').get(sessionId, target);
  }
  return { renderUrl: `api/session/${encodeURIComponent(sessionId)}/render/${grant.token}/${encodeURIComponent(basename(target))}`,
    renderInline: !(/\.(?:md|markdown)$/i.test(target) && bytes > 8 * 1024 * 1024) };
}

export async function serveRenderedFile(req, res, { session, token, asset, resolveFile }) {
  const fail = (code, message) => { res.writeHead(code, {'content-type': 'text/plain', 'cache-control': 'no-store'}); res.end(message); };
  const grant = db.prepare('SELECT entry_path FROM file_render_grants WHERE token=? AND session_id=?').get(token, session.id);
  if (!grant) return fail(404, 'Preview not found');
  // Re-check the original entry's authorization; a token never grants arbitrary
  // project access. Relative resources are limited to its real containing folder.
  const approved = await resolveFile(session, grant.entry_path);
  if (!approved || !sameStoragePath(approved.target, grant.entry_path)) return fail(403, 'Preview no longer authorized');
  let name;
  try { name = decodeURIComponent(asset); } catch { return fail(400, 'Invalid path'); }
  if (!name || name.includes('\\') || name.includes('\0') || name.split('/').some(p => !p || p.startsWith('.'))) return fail(403, 'Invalid preview path');
  const type = types[extname(name).toLowerCase()];
  if (!type) return fail(415, 'This file type is not served by rendered previews');
  let root, target, info, file;
  try {
    root = await realpath(dirname(grant.entry_path)).catch(async error => {
      if (error.code === 'ENOENT' && await archivedFile(session.id, grant.entry_path)) return dirname(grant.entry_path);
      throw error;
    });
    const candidate = join(root, name);
    target = await realpath(candidate).catch(async error => {
      if (error.code === 'ENOENT' && await archivedFile(session.id, candidate)) return candidate;
      throw error;
    });
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) return fail(403, 'Outside preview folder');
    file = await storedFileInfo(session.id, target);
    if (file.canonicalTarget) {
      const canonicalRel = relative(root, file.canonicalTarget);
      if (canonicalRel.startsWith('..') || isAbsolute(canonicalRel)) return fail(403, 'Outside preview folder');
    }
    info = file.info;
  } catch (error) { return fail(error.status || 404, error.status === 503 ? error.message : 'Preview file not found'); }
  if (!info.isFile()) return fail(400, 'Not a file');
  const host = String(req.headers.host || 'localhost');
  if (!/^[a-z0-9.:[\]-]+$/i.test(host)) return fail(400, 'Invalid host');
  const prefix = `/aios/api/session/${encodeURIComponent(session.id)}/render/${token}/`;
  const sources = [prefix, prefix.slice('/aios'.length)].flatMap(path => [`http://${host}${path}`, `https://${host}${path}`]).join(' ');
  const csp = `sandbox allow-scripts allow-popups; default-src 'none'; script-src 'unsafe-inline' ${sources}; style-src 'unsafe-inline' ${sources}; img-src data: blob: ${sources}; font-src data: ${sources}; media-src blob: ${sources}; connect-src ${sources}; frame-src ${sources}; base-uri 'none'; form-action 'none'; object-src 'none'`;
  const headers = {
    'content-type': type, 'content-security-policy': csp, 'x-content-type-options': 'nosniff',
    'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    // Sandboxed scripts have an opaque origin. Only this scoped read-only route
    // enables CORS; the application's API never inherits it.
    'access-control-allow-origin': '*',
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(basename(target))}`,
  };
  if (/\.(?:md|markdown)$/i.test(target)) {
    if (info.size > 8 * 1024 * 1024) return fail(413, 'Markdown too large to render; use Source or Download');
    let text;
    try { text = (await storedFileRead(target, file, 8 * 1024 * 1024)).toString('utf8'); }
    catch { return fail(503, 'Archive storage unavailable; retry when storage reconnects'); }
    res.writeHead(200, headers);
    const hostname = new URL(`http://${host}`).hostname;
    const html = renderMarkdown(text, { linkHref(href) {
      if (!isFileReference(href, hostname)) return href;
      const local = localFilePath(href, hostname);
      const absolute = isAbsolute(local) || local.startsWith('~/') ? local : join(dirname(target), local);
      const rel = relative(root, absolute);
      // Relative resources keep the document's grant; absolute/home links beyond
      // this folder go through the normal session authorization before opening.
      if (!local.startsWith('~/') && !rel.startsWith('..') && !isAbsolute(rel) && types[extname(absolute).toLowerCase()]) {
        return prefix + rel.split('/').map(encodeURIComponent).join('/') + (href.match(/#[^#]*$/)?.[0] || '');
      }
      return `/aios/api/session/${encodeURIComponent(session.id)}/file?path=${encodeURIComponent(absolute)}&open=1`;
    } });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(basename(target))}</title><style>body{font:16px/1.6 system-ui;max-width:960px;margin:24px auto;padding:0 20px;color:#20252b;background:#fff;overflow-wrap:anywhere}pre{overflow:auto;padding:16px;background:#f3f4f6}code{font-family:ui-monospace,monospace}table{border-collapse:collapse;display:block;overflow:auto}th,td{padding:8px;border:1px solid #ccc}img{max-width:100%}a{color:#0969da}</style>${html}`);
    return;
  }
  // Stream full HTML (large dashboards commonly exceed the source viewer's 2 MB
  // text limit). Truncating here would cut scripts in half and yield blank pages.
  res.writeHead(200, {...headers, 'content-length': info.size});
  const stream = storedFileStream(target, file);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
