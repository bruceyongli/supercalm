import assert from 'node:assert/strict';
import { createTerminalPipeRepair } from '../src/terminal_pipe.js';
import { shquote } from '../src/util.js';

const entry = (tmux, extra = {}) => ({ tmux, logFile: `/private/test logs/${tmux}'s.log`, ...extra });
let clock = 100, repaired = [], calls = [], dirs = [], fail = false;
const tmux = async (...args) => {
  calls.push(args);
  if (args[0] === 'list-panes') {
    await new Promise(resolve => setTimeout(resolve, 10));
    return 'broken\t%1\t0\t0\t1\t1\nhealthy\t%2\t1\t0\t1\t1\ndead\t%3\t0\t1\t1\t1\n'
      + 'foreign\t%4\t0\t0\t1\t1\nretired\t%5\t0\t0\t1\t1\nrelaunching\t%6\t0\t0\t1\t1\n'
      + 'broken\t%7\t0\t0\t0\t1\n';
  }
  if (args[0] === 'pipe-pane' && fail) throw new Error('disk full');
  return '1\n';
};
const repair = createTerminalPipeRepair({ tmux, clock: () => clock, ensureDir: async dir => dirs.push(dir), onRepair: e => repaired.push(e.tmux) });
const broken = entry('broken');
const entries = [broken, entry('healthy'), entry('dead'), entry('missing'), entry('pending-start'),
  entry('retired', { tailRetired: true }), entry('relaunching', { relaunching: true })];
await Promise.all(Array.from({ length: 5 }, () => repair(entries)));
assert.equal(calls.filter(c => c[0] === 'list-panes').length, 1, 'connect and periodic checks share one flight');
assert.deepEqual(calls.filter(c => c[0] === 'pipe-pane'), [['pipe-pane', '-o', '-t', '%1', `exec cat >> ${shquote(broken.logFile)}`]]);
assert.deepEqual(repaired, ['broken'], 'only the owned active live pane with no logger is repaired');
assert.deepEqual(dirs, ['/private/test logs']);
await repair(entries);
assert.equal(repaired.length, 1, 'failed/unsettled loggers are not retried in a hot loop');
clock += 5000; fail = true;
await repair(entries);
assert.equal(repaired.length, 1, 'a failed attachment never reports recovery');
clock += 5000; fail = false;
await repair(entries);
assert.equal(repaired.length, 2, 'recovery retries after the filesystem becomes writable');
assert.ok(calls.every(c => ['list-panes', 'pipe-pane', 'display-message'].includes(c[0])), 'never sends input, restarts agents, or closes healthy pipes');
console.log('terminal_pipe: missing logger repair, batching, ownership, quoting and retry bounds passed');
