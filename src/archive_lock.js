// Cross-process POSIX flock, held by the Node parent's inherited file description. The kernel
// releases it on exit/reboot; a stale owner record must never strand session recovery.
import { mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

function location(id) {
  if (!/^s_[a-zA-Z0-9_-]+$/.test(id || '')) throw new Error('Invalid archive session');
  return join(DATA_DIR, 'session-archive-locks', id + '.lock');
}
function busy() {
  return Object.assign(new Error('Session storage is being migrated or restored. Its data is preserved; retry when this finishes.'),
    { code: 'session-archive-in-progress', status: 409 });
}
const lockScript = `import fcntl,sys
try: fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError: sys.exit(75)
`;
export async function withSessionArchiveLock(id, operation) {
  const path = location(id);
  await mkdir(join(DATA_DIR, 'session-archive-locks'), { recursive: true, mode: 0o700 });
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    await new Promise((resolve, reject) => {
      // Python is the same small POSIX lock helper used by bin/deploy on macOS; no npm dependency.
      const child = spawn('python3', ['-c', lockScript], { stdio: ['ignore', 'ignore', 'pipe', file.fd] });
      let detail = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.stderr.on('data', b => { detail = (detail + b).slice(-300); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(code === 75 ? busy() : new Error('Cannot verify storage lease: ' + (detail || 'lock helper unavailable')));
      });
    });
    await file.truncate(0);
    await file.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    return await operation();
  } finally { await file.close(); } // Keep the inode: unlinking a lock file would permit two owners.
}
