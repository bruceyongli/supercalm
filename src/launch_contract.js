// LAUNCH CONTRACT (v4 Phase 3, traceability A8/A4; ARCHITECTURE.md §8): every session gets an
// IMMUTABLE manifest at launch — the identity and flags it was born with. Resume verifies against
// it: silently-lost flags (the hand-typed `codex resume` that dropped
// --dangerously-bypass-approvals and stranded work on approval prompts) are RESTORED from the
// manifest; identity drift (cwd/worktree/branch/tool) REFUSES loudly instead of degrading. Rows
// mutate legitimately (settings changes update them); the manifest catches values that vanished.
import { writeFile, readFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

const dir = () => join(DATA_DIR, 'launch');
const file = (sid) => join(dir(), sid + '.manifest.json');

export async function writeManifest(sid, m) {
  await mkdir(dir(), { recursive: true });
  const f = file(sid);
  try { await chmod(f, 0o600); } catch {} // a relaunch may overwrite its own manifest
  await writeFile(f, JSON.stringify({ ...m, sid, at: Date.now() }, null, 1) + '\n', { mode: 0o600 });
  try { await chmod(f, 0o400); } catch {} // read-only: immutability as a stance, not just a comment
}

export async function readManifest(sid) {
  try { return JSON.parse(await readFile(file(sid), 'utf8')); } catch { return null; }
}

// Pure verdict. session = the current row; actual = { branch } observed from the reused worktree.
// - restore: flag fields present at launch but NULL/empty on the row now (silent loss) -> heal.
// - refuse: identity fields that must never drift across a resume.
export function verifyResume(manifest, session, actual = {}) {
  if (!manifest) return { ok: true, restore: {}, mismatches: [] }; // pre-manifest sessions: fail-open
  const mismatches = [];
  const restore = {};
  if (manifest.tool && session.tool && manifest.tool !== session.tool) mismatches.push(`tool: launched as ${manifest.tool}, row says ${session.tool}`);
  if (manifest.worktree_path && session.worktree_path && manifest.worktree_path !== session.worktree_path) mismatches.push(`worktree: launched in ${manifest.worktree_path}, row says ${session.worktree_path}`);
  if (manifest.branch && actual.branch && manifest.branch !== actual.branch) mismatches.push(`branch: launched on ${manifest.branch}, worktree now on ${actual.branch}`);
  for (const k of ['autonomy', 'effort', 'model', 'orchestration']) {
    if (manifest[k] && !session[k]) restore[k] = manifest[k]; // silent loss -> heal from the manifest
  }
  return { ok: mismatches.length === 0, restore, mismatches };
}
