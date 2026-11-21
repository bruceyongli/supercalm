// A fixed preflight for one verified SSH host. Its credential travels on stdin.
import { homedir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { access, mkdir, lstat, realpath, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
const exists = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const domain = 'gui/' + process.getuid();
const isLoaded = label => { try { execFileSync('/bin/launchctl', ['print', domain + '/' + label], {stdio:'ignore'}); return true; } catch { return false; } };
async function prerequisites() {
  if (platform() !== 'darwin' || arch() !== 'arm64') throw Error('Choose an Apple Silicon Mac');
  execFileSync('/bin/launchctl', ['print', domain], {stdio:'ignore'});
  execFileSync('/usr/bin/git', ['--version'], {stdio:'ignore'});
  await access('/opt/homebrew/bin/tmux', 1);
}
async function freePorts() {
  for (const port of [8794, 18793]) await new Promise((ok, fail) => {
    const server = createServer(); server.once('error', () => fail(Error('Worker or callback port is already in use')));
    server.listen(port, '127.0.0.1', () => server.close(ok));
  });
}
export async function reserveWorker(token, {homeDir=homedir(), loaded=isLoaded, check=prerequisites, ports=freePorts}={}) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error('Invalid pairing credential');
  const home = await realpath(homeDir), parent = join(home, '.local/share'), root = join(parent, 'supercalm-executor');
  const tokenPath = join(root, 'control-token');
  await check();
  if (loaded('ai.aios.server') || await exists(join(home,'Library/LaunchAgents/ai.aios.server.plist'))) throw Error('This Mac is already a controller');
  // Never adopt or restart another worker, even through a second SSH alias.
  if (await exists(root) && (await realpath(root) !== root || (await lstat(root)).dev !== (await lstat(home)).dev)) throw Error('Worker directory is not on the local SSD');
  if (await exists(tokenPath)) {
    if (!(await lstat(tokenPath)).isFile() || (await readFile(tokenPath,'utf8')).trim() !== token) throw Error('This Mac already belongs to another worker');
  } else {
    if (await exists(root) || loaded('ai.aios.executor') || await exists(join(home,'Library/LaunchAgents/ai.aios.executor.plist'))) throw Error('This account already has a worker installation; it was not changed');
    await ports();
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (await realpath(parent) !== parent || (await lstat(parent)).dev !== (await lstat(home)).dev) throw Error('Worker directory must be on the local SSD');
    await mkdir(root, { mode: 0o700 });
    await writeFile(tokenPath, token + '\n', {flag:'wx', mode:0o600});
  }
  return {root};
}
