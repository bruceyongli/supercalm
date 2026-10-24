#!/usr/bin/env node
// Local launchd watcher. The Keychain helper is local, so it can reconnect a missing data volume.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, mkdir, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateLiveStorage } from '../src/live_storage.js';
const exec = promisify(execFile);
const file = process.argv[2];
if (!file) throw new Error('Usage: storage-mount-watch.mjs CONFIG [--once]');
const initial = validateLiveStorage(JSON.parse(await readFile(file, 'utf8')));
const statusFile = initial.statusFile || join(dirname(file), 'mount-status.json');
let delay = 15000, last = '';
async function check() {
  const config = validateLiveStorage(JSON.parse(await readFile(file, 'utf8')));
  const state = { checkedAt: Date.now(), id: config.id, mount: config.mount, available: false };
  try {
    let rows = (await exec('/sbin/mount', [], { timeout: 5000 })).stdout;
    const share = config.shareMount || config.mount;
    if (!rows.split('\n').some(row => row.includes(` on ${share} (smbfs,`))) {
      await mkdir(share, { mode: 0o500 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
      const st = await lstat(share);
      if (!st.isDirectory() || (st.mode & 0o222)) throw new Error('Unmounted mountpoint must be a non-writable directory');
      // macOS may spawn a persistent SMB monitor with the helper's inherited cwd.
      // Never pin an agent worktree or a future migration source from that daemon.
      await exec(config.helper, ['mount', config.service, config.account, config.url, share], { timeout: 30000, cwd: '/' });
    }
    if (config.image) {
      if (!config.image.startsWith(share + '/') || !config.image.endsWith('.sparsebundle')) throw new Error('Image must reside on the configured Spark share');
      rows = (await exec('/sbin/mount', [], { timeout: 5000 })).stdout;
      if (!rows.split('\n').some(row => row.includes(` on ${config.mount} (apfs,`))) {
        await mkdir(config.mount, { mode: 0o500 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
        const st = await lstat(config.mount);
        if (!st.isDirectory() || (st.mode & 0o222)) throw new Error('Unmounted data mountpoint must be non-writable');
        // Never force-detach, repair, erase or reformat an unavailable data volume.
        await exec('/usr/bin/hdiutil', ['attach', '-nobrowse', '-owners', 'on', '-mountpoint', config.mount, config.image], { timeout: 60000 });
      }
      const info = (await exec('/usr/bin/hdiutil', ['info'], { timeout: 10000 })).stdout;
      const images = info.split(/^=+$/m);
      if (!images.some(block => block.match(/^image-path\s*:\s*(.+)$/m)?.[1]?.trim() === config.image
        && block.split('\n').some(line => line.startsWith('/dev/') && line.trimEnd().endsWith('\t' + config.mount)))) {
        throw new Error('Mounted data volume is not backed by the configured Spark image');
      }
    }
    // A wedged network mount cannot block the watcher/event loop indefinitely.
    const script = `const fs=require('node:fs');const p=process.argv[1];const c=JSON.parse(fs.readFileSync(p));
      const a=fs.statSync(c.mount),b=fs.statSync(require('node:path').dirname(c.mount));
      if(a.dev===b.dev||fs.readFileSync(c.mount+'/.aios-storage-id','utf8').trim()!==c.id)process.exit(1);
      function capacity(p){const s=fs.statfsSync(p);return {total_bytes:s.blocks*s.bsize,available_bytes:s.bavail*s.bsize,used_bytes:(s.blocks-s.bfree)*s.bsize};}
      console.log(JSON.stringify({volume:capacity(c.mount),backing:capacity(c.shareMount||c.mount)}));`;
    const probe = await exec(process.execPath, ['-e', script, file], { timeout: 10000, killSignal: 'SIGKILL' });
    Object.assign(state, JSON.parse(probe.stdout));
    state.available = true; delay = 15000;
  } catch (error) { state.error = String(error.message).slice(0, 350); delay = Math.min(delay * 2, 300000); }
  await writeFile(statusFile + '.tmp', JSON.stringify(state), { mode: 0o600 });
  await rename(statusFile + '.tmp', statusFile);
  const signature = JSON.stringify([state.available, state.error]);
  if (signature !== last) { console.log(JSON.stringify(state)); last = signature; }
  return state;
}
do {
  const result = await check();
  if (process.argv.includes('--once')) { process.exitCode = result.available ? 0 : 1; break; }
  await new Promise(resolve => setTimeout(resolve, delay));
} while (true);
