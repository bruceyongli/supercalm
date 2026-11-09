#!/usr/bin/env node
// Traverse Git on SSD. A published seed is optional; source refs/HEAD/index win.
// No source hooks, config, alternates or credentials are exported.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, lstat, statfs, rm, readdir, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { executionGit } from '../src/execution_git.js';

const source = await realpath(process.argv[2]);
const selected = process.argv[3] ? JSON.parse(Buffer.from(process.argv[3], 'base64')) : {};
const root = process.env.AIOS_EXECUTION_EXPORT_ROOT || join(homedir(), '.local/share/aios/execution-export');
await mkdir(root, { recursive: true, mode: 0o700 });
const homeDevice = (await lstat(homedir())).dev;
if ((await lstat(await realpath(root))).dev !== homeDevice) throw Error('Git export staging must be on local SSD');
const capacity = async () => { const s = await statfs(root); if (s.bavail * s.bsize < 10 * 1024 ** 3) throw Error('Git export needs at least 10 GiB free on the local SSD'); };
await capacity();
const stage = await mkdtemp(join(root, 'git-'));
let active = null, cancelled = null;
const cancel = () => {
  cancelled ||= Error('Git export interrupted; source retained');
  if (active?.pid) { try { process.kill(-active.pid, 'SIGKILL'); } catch {} }
};
process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
const run = (args, { input, output = 'capture', timeout = 10 * 60_000, env = {}, onData } = {}) => new Promise((resolve, reject) => {
  if (cancelled) return reject(cancelled);
  const child = active = spawn('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    detached: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env }, stdio: [input === undefined ? 'ignore' : 'pipe', output === 'inherit' ? 'inherit' : 'pipe', 'pipe'],
  });
  let failure = null, bytes = 0; const chunks = [];
  if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  child.stderr.resume();
  const stop = error => { failure ||= error; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  child.stdout?.on('data', chunk => {
    if (onData) { try { onData(chunk); } catch (error) { stop(error); } }
    else if (output === 'capture') {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) stop(Error('Git export metadata exceeds limit'));
      else chunks.push(chunk);
    }
  });
  const deadline = setTimeout(() => stop(Error('Git export step timed out; source retained')), timeout);
  const monitor = setInterval(() => capacity().catch(stop), 5000);
  child.on('error', error => { failure ||= error; });
  child.on('close', code => { clearTimeout(deadline); clearInterval(monitor); active = null;
    if (cancelled || failure || code !== 0) reject(cancelled || failure || Error('Git export failed; source retained'));
    else resolve(Buffer.concat(chunks).toString('utf8')); });
});
try {
  const mirror = join(stage, 'repository.git');
  const common = await realpath((await executionGit(source, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  const head = selected.head || (await executionGit(source, ['rev-parse', 'HEAD'])).trim();
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw Error('Invalid Git HEAD');
  const refs = (await executionGit(source, ['for-each-ref', '--format=%(objectname) %(refname)'])).trim().split('\n').filter(Boolean).map(line => {
    const match = line.match(/^([a-f0-9]{40,64}) (refs\/[^\s]+)$/);
    if (!match) throw Error('Invalid Git reference snapshot');
    return { oid: match[1], name: match[2] };
  });
  const index = selected.index || (await executionGit(source, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
  // Staged blobs may be unreachable from every commit. Export their objects too.
  await copyFile(index, join(stage, 'index'), 1);
  const indexOids = new Set(); let tail = '';
  await run(['--git-dir=' + common, 'ls-files', '--stage', '-z'], { env: { GIT_INDEX_FILE: join(stage, 'index') }, onData: chunk => {
    tail += chunk.toString('utf8'); const rows = tail.split('\0'); tail = rows.pop();
    for (const row of rows) {
      const match = row.match(/^(\d+) ([a-f0-9]{40,64}) [0-3]\t/);
      if (!match || match[1] === '160000') throw Error('Unsupported Git index entry');
      if (!/^0+$/.test(match[2])) indexOids.add(match[2]);
    }
  } });
  try { await lstat(join(common, 'objects/info/alternates')); throw Error('Git export depends on an external object store'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const remoteSource = (await lstat(common)).dev !== homeDevice || process.env.AIOS_EXECUTION_EXPORT_STAGE === '1';
  if (!remoteSource) {
    await run(['-C', source, 'bundle', 'create', '-', '--all', 'HEAD', '--stdin'], { input: [...indexOids, head].join('\n') + '\n', output: 'inherit' });
  } else {
    let origin = await executionGit(source, ['config', '--get', 'remote.origin.url']).catch(error => { if (error.exitCode === 1) return ''; throw error; });
    origin = origin.trim();
    // Never use ext transports or local paths from repository config as a seed.
    if (/^(https:\/\/[^/@\s]+\/|[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:|ssh:\/\/[a-zA-Z0-9_.@-]+\/)/.test(origin)) {
      try { await run(['-c', 'protocol.ext.allow=never', 'clone', '--mirror', '--quiet', '--', origin, mirror], {
        timeout: 90000, output: 'ignore', env: { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes' },
      }); } catch (error) { if (cancelled) throw error; await rm(mirror, { recursive: true, force: true }); }
    }
    await run(['init', '--bare', '--quiet', mirror]);
    // Read packs sequentially, then hydrate only missing reachable loose objects.
    const packRoot = join(common, 'objects/pack');
    await mkdir(join(mirror, 'objects/pack'), { recursive: true });
    for (const entry of await readdir(packRoot, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
      if (!/^pack-[a-f0-9]+\.(?:pack|idx)$/.test(entry.name)) continue;
      if (!entry.isFile()) throw Error('Git pack is not a regular file');
      await capacity();
      try { await copyFile(join(packRoot, entry.name), join(mirror, 'objects/pack', entry.name), 1); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const roots = [...new Set([head, ...refs.map(r => r.oid), ...indexOids])];
    const copyMissing = async ids => {
      let next = 0;
      const results = await Promise.allSettled(Array.from({ length: 8 }, async () => {
        for (;;) {
          if (cancelled) throw cancelled;
          const oid = ids[next++]; if (!oid) return;
          const from = join(common, 'objects', oid.slice(0, 2), oid.slice(2));
          if (!(await lstat(from)).isFile()) throw Error('Missing or non-regular Git object; source retained');
          await mkdir(join(mirror, 'objects', oid.slice(0, 2)), { recursive: true });
          await copyFile(from, join(mirror, 'objects', oid.slice(0, 2), oid.slice(2)), 1);
        }
      }));
      const failed = results.find(r => r.status === 'rejected'); if (failed) throw failed.reason;
    };
    const present = await run(['-C', mirror, 'cat-file', '--batch-check'], { input: roots.join('\n') + '\n' });
    await copyMissing(present.split('\n').filter(line => line.endsWith(' missing')).map(line => line.split(' ')[0]));
    for (let round = 0; ; round++) {
      if (round > 10000) throw Error('Git object traversal exceeded its bound');
      const missing = new Set(); let line = '';
      await run(['-C', mirror, 'rev-list', '--objects', '--no-object-names', '--missing=print', '--stdin'], {
        input: roots.join('\n') + '\n', onData: chunk => {
          line += chunk.toString('utf8'); const rows = line.split('\n'); line = rows.pop();
          for (const row of rows) if (/^\?[a-f0-9]{40,64}$/.test(row)) missing.add(row.slice(1));
        },
      });
      if (!missing.size) break;
      await capacity(); await copyMissing([...missing]);
    }
    const old = await run(['-C', mirror, 'for-each-ref', '--format=%(refname)']);
    await run(['-C', mirror, 'update-ref', '--stdin'], { input: old.split('\n').filter(Boolean).map(ref => `delete ${ref}\n`).join('') });
    await run(['-C', mirror, 'update-ref', '--stdin'], { input: refs.map(r => `update ${r.name} ${r.oid}\n`).join('') });
    await run(['-C', mirror, 'update-ref', '--no-deref', 'HEAD', head]);
    await run(['-C', mirror, 'bundle', 'create', '-', '--all', 'HEAD', '--stdin'], { input: [...indexOids].join('\n') + '\n', output: 'inherit' });
  }
} finally {
  await rm(stage, { recursive: true, force: true });
  process.off('SIGTERM', cancel); process.off('SIGINT', cancel);
}
