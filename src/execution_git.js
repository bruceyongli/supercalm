// Migration scans may read a cold network worktree. Stream large evidence instead
// of treating execFile's stdout limit or a one-minute UI deadline as repository loss.
import { spawn } from 'node:child_process';
import { migrationError } from './execution_identity.js';

export function executionGit(path, args, { label = args[0], timeout = 10 * 60_000,
  onData, maxBytes = 1024 * 1024, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('/usr/bin/git', ['-C', path, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      detached: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = []; let bytes = 0, failed = null, settled = false;
    const fail = error => {
      if (failed) return;
      failed = error;
      // Own process group only: do not leave pack/filter children behind after a
      // deadline. No source files, agent terminals or user processes are touched.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => fail(migrationError(`Git ${label} timed out while reading the source. Originals are unchanged; retry after storage recovers.`, 'execution-git-timeout', 503)), timeout);
    child.stderr.resume(); // Git stderr can contain private paths/credentials.
    child.stdout.on('data', chunk => {
      if (failed) return;
      try {
        if (onData) onData(chunk);
        else {
          bytes += chunk.length;
          if (bytes > maxBytes) return fail(migrationError(`Git ${label} returned too much metadata; originals are unchanged.`, 'execution-git-output', 503));
          chunks.push(chunk);
        }
      } catch (error) { fail(error); }
    });
    child.once('error', error => {
      if (settled) return; settled = true; clearTimeout(timer);
      reject(migrationError(`Git ${label} could not start (${error.code || 'unavailable'}).`, 'execution-git-unavailable', 503));
    });
    child.once('close', (code, signal) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (failed) reject(failed);
      else if (code !== 0) reject(Object.assign(migrationError(`Git ${label} failed (${signal || 'exit ' + code}); originals are unchanged.`, 'execution-git-failed', 503), { exitCode: code }));
      else resolve(onData ? undefined : Buffer.concat(chunks).toString('utf8'));
    });
  });
}
