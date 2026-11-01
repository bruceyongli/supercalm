#!/usr/bin/env node
// Narrow adapter for an ordinary npm/pnpm/yarn/bun run build. No deployment
// permission, snapshot, persistent cache or source edits are introduced here.
import { spawn } from 'node:child_process';
import { buildCopyEnvironment } from '../src/build_copy_env.js';
const args = process.argv.slice(2);
let source = process.cwd();
if (args[0] === '--source') { args.shift(); source = args.shift(); }
const executable = args.shift();
if (!executable) throw Error('Build executable required');
const child = spawn(executable, args, { env: buildCopyEnvironment(source), stdio: 'inherit' });
let spawnFailed = false;
const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => child.kill(signal)]);
for (const [signal, handler] of handlers) process.on(signal, handler);
function done(code) {
  for (const [signal, handler] of handlers) process.off(signal, handler);
  process.exitCode = code;
}
child.once('error', e => { spawnFailed = true; console.error(e.message); done(127); });
child.once('close', (code, signal) => { if (!spawnFailed) done(code ?? (signal === 'SIGINT' ? 130 : 143)); });
