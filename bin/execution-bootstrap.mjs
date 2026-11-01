#!/usr/bin/env node
// User-scoped runtime installation. Does not replace Homebrew Node or other CLIs.
import { mkdir, readFile, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, arch, platform } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = join(homedir(), '.local/share/supercalm-executor');
if (platform() !== 'darwin' || arch() !== 'arm64') throw Error('This installer supports Apple Silicon Macs');
await mkdir(root, { recursive: true, mode: 0o700 });
if ((await lstat(await realpath(root))).dev !== (await lstat(homedir())).dev) throw Error('Worker root must be on the local SSD');
const runtime = join(root, 'runtime');
await mkdir(runtime, { recursive: true, mode: 0o700 });
const version = 'v25.8.0', name = `node-${version}-darwin-arm64.tar.gz`;
const nodeRoot = join(runtime, name.replace(/\.tar\.gz$/, ''));
try { await lstat(join(nodeRoot, 'bin/node')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const base = `https://nodejs.org/dist/${version}`;
  const sums = await fetch(`${base}/SHASUMS256.txt`).then(r => { if (!r.ok) throw Error('Node checksum unavailable'); return r.text(); });
  const expected = sums.split('\n').find(line => line.endsWith('  ' + name))?.split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(expected || '')) throw Error('No official Node checksum');
  const response = await fetch(`${base}/${name}`);
  if (!response.ok) throw Error('Node download unavailable');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('Node download checksum mismatch');
  const archive = join(runtime, name);
  await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
  await exec('/usr/bin/tar', ['-xzf', archive, '-C', runtime], { timeout: 120000 });
  await rm(archive);
}
const cli = join(runtime, 'cli');
const env = { ...process.env, PATH: `${nodeRoot}/bin:/opt/homebrew/bin:/usr/bin:/bin`,
  npm_config_cache: join(runtime, 'npm-cache'), npm_config_update_notifier: 'false' };
await exec(join(nodeRoot, 'bin/node'), [join(nodeRoot, 'lib/node_modules/npm/bin/npm-cli.js'),
  'install', '--prefix', cli, '--no-audit', '--no-fund', '@openai/codex@0.164.0', '@anthropic-ai/claude-code@2.1.316'],
{ env, timeout: 10 * 60_000, maxBuffer: 1024 * 1024 });
const versions = {};
for (const [name, path] of [['node', join(nodeRoot, 'bin/node')], ['codex', join(cli, 'node_modules/.bin/codex')],
  ['claude', join(cli, 'node_modules/.bin/claude')], ['tmux', '/opt/homebrew/bin/tmux']]) {
  versions[name] = (await exec(path, [name === 'tmux' ? '-V' : '--version'], { env, timeout: 15000 })).stdout.trim();
}
await writeFile(join(root, 'runtime.json'), JSON.stringify({ node: join(nodeRoot, 'bin/node'),
  path: `${cli}/node_modules/.bin:${nodeRoot}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, versions }, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ root, versions }));
