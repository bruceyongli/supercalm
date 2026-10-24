// One fail-soft git primitive, shared across modules (sessions.js, worktrees.js).
// `git -C <cwd> <args>` — NEVER throws; returns { text, error, diagnostics? }. Bounded (maxBuffer/timeout/SIGKILL)
// so a wedged git call can never stall a caller's poll/tail loop. Extracted from sessions.js, which
// held the only copy (src/agents/supervisor/thrash.js still keeps its own private variant).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function gitOut(cwd, args, { maxBuffer = 2 * 1024 * 1024, timeout = 4500 } = {}) {
  const started = Date.now();
  try {
    // Status/diff observations must not refresh the index or create transient locks.
    // Required locks for actual worktree/add/commit operations are unaffected.
    const r = await exec('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer, timeout, killSignal: 'SIGKILL', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    return { text: String(r.stdout || '').trimEnd(), error: '' };
  } catch (e) {
    const elapsedMs = Date.now() - started;
    return { text: '', error: String(e.message || e), diagnostics: {
      code: e.code ?? null, signal: e.signal || null, killed: e.killed === true,
      timedOut: timeout > 0 && e.killed === true && e.signal === 'SIGKILL' && e.code == null && elapsedMs >= timeout,
      timeoutMs: timeout, elapsedMs, stderr: String(e.stderr || '').trimEnd(),
    } };
  }
}
