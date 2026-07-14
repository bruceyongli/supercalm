// One fail-soft git primitive, shared across modules (sessions.js, worktrees.js).
// `git -C <cwd> <args>` — NEVER throws; returns { text, error }. Bounded (maxBuffer/timeout/SIGKILL)
// so a wedged git call can never stall a caller's poll/tail loop. Extracted from sessions.js, which
// held the only copy (src/agents/supervisor/thrash.js still keeps its own private variant).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function gitOut(cwd, args, { maxBuffer = 2 * 1024 * 1024, timeout = 4500 } = {}) {
  try {
    const r = await exec('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer, timeout, killSignal: 'SIGKILL' });
    return { text: String(r.stdout || '').trimEnd(), error: '' };
  } catch (e) {
    return { text: '', error: String(e.message || e) };
  }
}
