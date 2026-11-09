// Exact recorded same-project roots authorize dependency rebuilding, never
// reading/following those links or treating their common parent as a project.
import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

const inside = (root, path) => path === root || path.startsWith(root + sep);
function safeSourceRoot(root, home = homedir()) {
  return typeof root === 'string' && root.length <= 4096 && isAbsolute(root) && resolve(root) === root
    && !/[\\\r\n\0]/.test(root) && root.split(sep).filter(Boolean).length >= 3
    && !inside(root, home) && !/(?:^|\/)proxy(?:\/|$)/.test(root);
}

export function validateDependencyRebuildPolicy(policy) {
  if (!policy || policy.version !== 1 || Object.keys(policy).some(key => !['version','allowedSourceRoots'].includes(key))
      || !Array.isArray(policy.allowedSourceRoots) || !policy.allowedSourceRoots.length || policy.allowedSourceRoots.length > 2048
      || policy.allowedSourceRoots.some(root => !safeSourceRoot(root))
      || new Set(policy.allowedSourceRoots).size !== policy.allowedSourceRoots.length) {
    throw Error('Invalid dependency rebuild source roots');
  }
  return { version: 1, allowedSourceRoots: [...policy.allowedSourceRoots] };
}

// Inputs are durable controller records. Worker-shadow paths alone lose the
// originals after a move, so previous exact operation snapshots remain evidence.
// No realpath lookup is needed on disconnected/archived source storage.
export function buildDependencyRebuildPolicy(spec, { project = spec.project, sessions = [], operations = [] } = {}) {
  const projectId = spec.project?.id;
  if (spec.kind !== 'move' || !/^p_[a-zA-Z0-9_-]+$/.test(projectId || '')
      || spec.session?.project_id !== projectId || project?.id !== projectId) throw Error('Dependency rebuild project identity conflict');
  const roots = new Set();
  const add = root => { if (safeSourceRoot(root)) roots.add(root); };
  const captured = value => {
    if (value?.project?.id !== projectId || value.session?.project_id !== projectId
        || !/^s_[a-zA-Z0-9_-]+$/.test(value.session?.id || '')) return;
    add(value.project.path); add(value.sourcePath); add(value.session.worktree_path);
  };
  captured(spec); add(project.path);
  for (const session of sessions) {
    if (session.project_id === projectId && /^s_[a-zA-Z0-9_-]+$/.test(session.id || '')) add(session.worktree_path);
  }
  for (const operation of operations) {
    if (operation.kind !== 'move') continue;
    let previous;
    try { previous = (typeof operation.detail === 'string' ? JSON.parse(operation.detail) : operation.detail)?.spec; }
    catch { continue; }
    if (previous?.kind !== 'move' || operation.session_id !== previous.session?.id) continue;
    captured(previous);
  }
  return validateDependencyRebuildPolicy({ version: 1, allowedSourceRoots: [...roots].sort() });
}
