// Controller routing only: this does not authorize a file or create a render grant.
// Cold originals keep their original URLs after execution moves to another Mac.
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize, sep } from 'node:path';
import { db, getProject, getSession } from './store.js';
import { remoteSession } from './execution_identity.js';
import { sessionStoragePaths } from './session_storage.js';
import { logicalStoragePath, sameStoragePath } from './live_storage.js';

const inside = (root, path) => path === root || path.startsWith(root + sep);

function requestedPath(value) {
  value = String(value || '').trim();
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'file:' || url.hostname && url.hostname !== 'localhost') return '';
      value = decodeURIComponent(url.pathname);
    } catch { return ''; }
  }
  value = value.replace(/#L\d+(?:C\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '');
  if (value.startsWith(`~${sep}`)) value = join(homedir(), value.slice(2));
  return isAbsolute(value) && !value.includes('\0') ? logicalStoragePath(normalize(value)) : '';
}

function coldContext(session) {
  if (!remoteSession(session)) return null;
  // Only the committed owner may use this policy. A failed/cancelled staging
  // attempt, a fresh launch, or another session/device cannot grant a cold root.
  const operation = db.prepare(`SELECT * FROM execution_operations
    WHERE session_id=? AND node=? AND kind='move' AND phase IN ('activating','complete')
    ORDER BY created_at DESC LIMIT 1`).get(session.id, session.execution_node);
  if (!operation || session.execution_transfer && session.execution_transfer !== operation.id) return null;
  let spec;
  try { spec = JSON.parse(operation.detail).spec; } catch { return null; }
  const policy = spec?.artifactCopyPolicy;
  const artifacts = sessionStoragePaths(session.id).artifacts;
  if (policy?.version !== 3 || policy.retainHistoricalArtifacts !== true || policy.originalsRetained !== true
      || spec.session?.id !== session.id || spec.session.project_id !== session.project_id
      || spec.project?.id !== session.project_id || !isAbsolute(policy.source || '')
      || normalize(policy.source) !== artifacts || spec.artifactsPath !== policy.source) return null;
  const project = getProject(session.project_id);
  const originalUploads = isAbsolute(spec.project.path || '')
    ? join(spec.project.path, '.aios', 'attachments', session.id) : '';
  const uploads = originalUploads && project && sameStoragePath(project.path, spec.project.path)
    && (!policy.attachmentsSource || policy.attachmentsSource === originalUploads) ? originalUploads : '';
  // Restore only original native evidence, not the old project's/worktree's file
  // scope. This is request-local; the shadow row and worker ownership stay intact.
  const evidenceSession = { ...session, execution_checkout: 0, execution_history_only: 0,
    codex_uuid: spec.session.codex_uuid || null,
    claude_transcript: (spec.session.tool === 'claude' ? spec.native?.path : null)
      || spec.session.claude_transcript || null };
  return { artifacts, uploads, session: evidenceSession };
}

// True means the execution router should fall through to the ordinary controller
// HTTP handlers. They must still apply resolveSessionFile, stored_file and the
// existing render-token checks. Never reverse all worker artifact paths: a new
// output on that device must not silently resolve to an older retained original.
export async function routeColdExecutionPreview(req, url, sessionOrId) {
  if (req.method !== 'GET') return false;
  const match = url.pathname.match(/^\/api\/session\/([^/]+)\/(file|attachment\/[^/]+|render\/[^/]+\/.+)$/);
  if (!match) return false;
  let sid;
  try { sid = decodeURIComponent(match[1]); } catch { return false; }
  const session = typeof sessionOrId === 'string' ? getSession(sessionOrId) : sessionOrId;
  if (!session || session.id !== sid) return false;
  const context = coldContext(session);
  if (!context) return false;
  const retained = value => {
    const path = requestedPath(value);
    return !!path && (inside(context.artifacts, path) || context.uploads && inside(context.uploads, path));
  };
  if (match[2] === 'file') {
    if (!retained(url.searchParams.get('path'))) return false;
  } else if (match[2].startsWith('render/')) {
    const token = match[2].split('/')[1];
    const grant = db.prepare('SELECT entry_path FROM file_render_grants WHERE token=? AND session_id=?').get(token, sid);
    if (!grant || !retained(grant.entry_path)) return false;
  } else {
    let name;
    try { name = decodeURIComponent(match[2].slice('attachment/'.length)); } catch { return false; }
    if (!context.uploads || !name || name !== basename(name) || name === '.' || name === '..' || /[\\\0]/.test(name)) return false;
    const source = join(context.uploads, name);
    try { await lstat(source); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    // The legacy attachment route reads directly. Use the normal file resolver
    // for cold uploads so an old filename cannot authorize an escaping symlink.
    url.pathname = `/api/session/${encodeURIComponent(sid)}/file`;
    url.searchParams.set('path', source);
    url.searchParams.set('raw', '1');
    req.url = url.pathname + url.search;
  }
  req.executionColdPreviewSession = context.session;
  return true;
}
