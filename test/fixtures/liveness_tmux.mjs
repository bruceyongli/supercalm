#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2), stateFile = process.env.LIVENESS_STATE;
const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const flag = name => args[args.indexOf(name) + 1];
appendFileSync(process.env.LIVENESS_TRACE, JSON.stringify(args) + '\n');
const current = state();
if (current.pause && args[0] === (current.pauseCommand || 'list-sessions')
    && (!current.pauseTarget || flag('-t') === current.pauseTarget) && !existsSync(current.pause)) {
  writeFileSync(current.pause, 'observed');
  while (state().pause) await new Promise(resolve => setTimeout(resolve, 10));
}
if (args[0] === 'list-sessions') {
  if (current.fail) { process.stderr.write('resource temporarily unavailable'); process.exit(1); }
  process.stdout.write(current.names.join('\n'));
} else if (args[0] === 'new-session') {
  writeFileSync(stateFile, JSON.stringify({ ...current, names: [...new Set([...current.names, flag('-s')])] }));
} else if (args[0] === 'kill-session') {
  writeFileSync(stateFile, JSON.stringify({ ...current, names: current.names.filter(n => n !== flag('-t')) }));
} else if (args[0] === 'display-message') {
  process.stdout.write(current.shells?.includes(flag('-t')) ? 'zsh' : 'codex');
} else if (args[0] === 'capture-pane') {
  process.stdout.write('› Explain this codebase');
}
