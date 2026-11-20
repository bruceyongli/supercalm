// Wake the owner of the mount. An in-progress APFS attach must be allowed to finish.
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { liveStorageConfig, liveStorageConfigFile, liveStorageStatus } from './live_storage.js';

const run = promisify(execFile);
const flights = new Map();
export function reconnectForResume(config = liveStorageConfig()) {
  if (!config) return Promise.resolve(false);
  if (flights.has(config.id)) return flights.get(config.id);
  const attempt = (async () => {
    const since = Date.now();
    const statusFile = config.statusFile || join(dirname(liveStorageConfigFile()), 'mount-status.json');
    await writeFile(statusFile + '.reconnect', String(since), { mode: 0o600 });
    if (process.platform === 'darwin') {
      const label = /^storage-[\da-f-]+$/.test(config.id) ? 'ai.aios.' + config.id : 'ai.aios.storage-mount';
      const service = 'gui/' + process.getuid() + '/' + label;
      const file = liveStorageConfigFile();
      const job = await run('/bin/launchctl', ['print', service], { timeout: 1000 }).catch(() => null);
      if (job?.stdout.split('\n').some(line => line.trim() === file)) {
        execFile('/bin/launchctl', ['kickstart', service], { timeout: 2000 }, () => {});
      }
    }
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      const status = liveStorageStatus({ ...config, statusFile });
      if (status.checked_at >= since) return status.available;
    }
    return false; // The watcher continues recovery after the interactive deadline.
  })().finally(() => flights.delete(config.id));
  flights.set(config.id, attempt);
  return attempt;
}
