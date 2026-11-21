// Migration scans may read a cold network worktree. Stream large evidence instead
// of treating execFile's stdout limit or a one-minute UI deadline as repository loss.
import { spawn } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { migrationError } from './execution_identity.js';

// Inspect commit objects on the destination SSD, not a network working tree.
export async function assertSelfContainedCommit(repo, head) {
  let tail = '';
  await executionGit(repo,['ls-tree','-r','-z',head],{onData:buf=>{
    const rows=(tail+buf.toString()).split('\0');tail=rows.pop();
    if (rows.some(r=>r.startsWith('160000 '))) throw migrationError('Submodule checkout needs separate local preparation');
  }});
}

export function executionGit(path, args, { label = args[0], timeout = 10 * 60_000,
  capacityDir, onData, maxBytes = 1024 * 1024, spawnProcess = spawn } = {}) {
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
    const guard = capacityDir && setInterval(() => statfs(capacityDir).then(s => {
      if (!settled && s.bavail * s.bsize < 10 * 1024 ** 3) fail(migrationError('Local SSD reserve reached; originals retained', 'disk-space-critical', 507));
    }, () => { if (!settled) fail(migrationError('Local SSD capacity unavailable')); }), 1000);
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
      if (settled) return; settled = true; clearTimeout(timer); clearInterval(guard);
      reject(migrationError(`Git ${label} could not start (${error.code || 'unavailable'}).`, 'execution-git-unavailable', 503));
    });
    child.once('close', (code, signal) => {
      if (settled) return; settled = true; clearTimeout(timer); clearInterval(guard);
      if (failed) reject(failed);
      else if (code !== 0) reject(Object.assign(migrationError(`Git ${label} failed (${signal || 'exit ' + code}); originals are unchanged.`, 'execution-git-failed', 503), { exitCode: code }));
      else resolve(onData ? undefined : Buffer.concat(chunks).toString('utf8'));
    });
  });
}
