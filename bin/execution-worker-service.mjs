#!/usr/bin/env node
// Invoked over the authenticated SSH connection by execution-node.mjs. Only owns
// this worker's service/app; never closes CLI tmux panes or another application.
import { readFile, writeFile, mkdir, rename, rm, realpath, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeExecutionNative } from '../src/execution_native.js';

const exec = promisify(execFile);
let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 65536) throw Error('Invalid worker configuration'); }
const config = JSON.parse(input);
if (!/^[a-zA-Z0-9_-]+$/.test(config.id) || !/^[a-f0-9]{64}$/.test(config.token)) throw Error('Invalid worker identity');
const root = await realpath(config.root), app = join(root, 'app'), home = homedir();
if (!root.startsWith(home + '/.local/share/') || (await lstat(root)).dev !== (await lstat(home)).dev) throw Error('The worker must use a dedicated local SSD directory');
const actual = (await exec('/usr/bin/git', ['-C', app, 'rev-parse', 'HEAD'])).stdout.trim();
if (actual !== config.sha) throw Error('Worker release identity mismatch');
const paths = ['data', 'workspaces', 'worktrees', 'native/codex', 'native/claude', 'tmp'];
for (const part of paths) await mkdir(join(root, part), { recursive: true, mode: 0o700 });
await initializeExecutionNative(root);
const tokenPath = join(root,'control-token');
try { if ((await readFile(tokenPath,'utf8')).trim() !== config.token) throw Error('Worker control identity differs; no automatic credential replacement'); }
catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(tokenPath, config.token + '\n', { flag: 'wx', mode: 0o600 }); }
await exec(config.runtime.node, [join(config.runtime.node, '../../lib/node_modules/npm/bin/npm-cli.js'), 'ci', '--omit=dev', '--ignore-scripts'], {
  cwd: app, timeout: 180000, maxBuffer: 1024 * 1024, env: { ...process.env, PATH: config.runtime.path, TMPDIR: join(root,'tmp') },
});
const callback = `http://127.0.0.1:${config.callbackPort}`;
const tmux = join(root,'tmux');
await writeFile(tmux, `#!/bin/sh\nexec /opt/homebrew/bin/tmux -L supercalm-exec-${config.id} "$@"\n`, { mode:0o700 });
const env = {
  PATH: config.runtime.path, AIOS_TOOL_PATH: config.runtime.path,
  AIOS_PORT: String(config.remotePort), AIOS_HOST: '127.0.0.1', AIOS_EXECUTION_NODE: config.id,
  AIOS_EXECUTION_LABEL: config.label, AIOS_EXECUTION_ROOT: root, AIOS_DATA: join(root,'data'),
  AIOS_TMUX: tmux, AIOS_CLAUDE_HOOKS: '1', AIOS_CODEX_NOTIFY: '1',
  AIOS_ENV_FILE: join(root,'worker.env'), AIOS_WORKTREE_ROOT: join(root,'worktrees'),
  CODEX_HOME: join(root,'native/codex'), CLAUDE_CONFIG_DIR: join(root,'native/claude'),
  AIOS_CODEX_SESSIONS_DIR: join(root,'native/codex/sessions'), AIOS_CODEX_HISTORY_FILE: join(root,'native/codex/history.jsonl'),
  AIOS_USAGE_CODEX_DIR: join(root,'native/codex/sessions'), AIOS_USAGE_CLAUDE_DIR: join(root,'native/claude/projects'),
  AIOS_USAGE_AGY_FILE: join(root,'native/no-agy.jsonl'), AIOS_USAGE_AGY_CLI_LOG_DIR: join(root,'native/no-agy'),
  AIOS_CLI_PROXY_BASE: callback + '/api/cli-proxy', AIOS_CLAUDE_BASE_URL: callback + '/api/cli-proxy',
  AIOS_CLAUDE_KEY: 'sk-aios-via-proxy', AIOS_EXECUTION_MODEL_URL: callback + '/api/execution/model',
  AIOS_EXECUTION_CATALOG_URL: callback + '/api/models', AIOS_AUTO_PUBLISH: '0', AIOS_RELEASE_MONITOR: '0',
  TMPDIR: join(root,'tmp'), TMP: join(root,'tmp'), TEMP: join(root,'tmp'),
};
const xml = value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const label = 'ai.aios.executor', domain = `gui/${process.getuid()}`, plist = join(home, `Library/LaunchAgents/${label}.plist`);
const source = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(config.runtime.node)}</string><string>${xml(join(app,'src/server.js'))}</string></array>
<key>WorkingDirectory</key><string>${xml(app)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>${xml(join(root,'data/worker.log'))}</string><key>StandardErrorPath</key><string>${xml(join(root,'data/worker.log'))}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict></dict></plist>\n`;
await mkdir(join(home,'Library/LaunchAgents'),{ recursive:true });
await writeFile(plist + '.tmp', source,{ mode:0o600 }); await rename(plist + '.tmp',plist);
await exec('/bin/launchctl',['bootout',`${domain}/${label}`]).catch(() => {});
await exec('/bin/launchctl',['bootstrap',domain,plist]);
await exec('/bin/launchctl',['enable',`${domain}/${label}`]);
await exec('/bin/launchctl',['kickstart',`${domain}/${label}`]);
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(`http://127.0.0.1:${config.remotePort}/api/execution/health`, {
      headers: { 'x-aios-node-token': config.token }, signal: AbortSignal.timeout(1000),
    });
    const health = await response.json();
    if (response.ok && health.node === config.id && health.commit === actual) { ready = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!ready) throw Error('Worker did not confirm the exact installed release; inspect its worker.log');
if (config.bundle.startsWith(join(root,'releases') + '/') && config.bundle.endsWith('.bundle')) await rm(config.bundle);
console.log(JSON.stringify({ node: config.id, localSSD: true, commit: actual, service: label }));
