import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { shquote } from './util.js';

// A live agent can outlast its pipe-pane logger (e.g. cat exits on ENOSPC). SSE then
// stays connected but receives only its initial snapshot. Repair the output tap,
// never the agent, and never replace an existing pipe or send terminal input.
export function createTerminalPipeRepair({ tmux, onRepair = () => {}, clock = Date.now,
  retryMs = 5000, ensureDir = path => mkdir(path, { recursive: true }) }) {
  let flight = null;
  async function check(entries) {
    const eligible = entries.filter(e => !e.tailRetired && !e.relaunching && e.tmux && !e.tmux.startsWith('pending-'));
    if (!eligible.length) return;
    const rows = await tmux('list-panes', '-a', '-F',
      '#{session_name}\t#{pane_id}\t#{pane_pipe}\t#{pane_dead}\t#{window_active}\t#{pane_active}');
    const panes = new Map(rows.trim().split('\n').map(row => row.split('\t'))
      .filter(p => p[4] === '1' && p[5] === '1').map(p => [p[0], p]));
    for (const entry of eligible) {
      const name = entry.tmux, pane = panes.get(name);
      if (!pane || pane[2] !== '0' || pane[3] !== '0' || clock() < (entry.nextPipeRepairAt || 0)) continue;
      entry.nextPipeRepairAt = clock() + retryMs;
      try {
        await ensureDir(dirname(entry.logFile));
        if (entry.tailRetired || entry.relaunching || entry.tmux !== name) continue;
        // -o closes the check/attach race: another owner may already have repaired it.
        await tmux('pipe-pane', '-o', '-t', pane[1], `exec cat >> ${shquote(entry.logFile)}`);
        const alive = await tmux('display-message', '-p', '-t', pane[1], '#{pane_pipe}');
        if (alive.trim() !== '1' || entry.tailRetired || entry.relaunching || entry.tmux !== name) continue;
        await onRepair(entry);
      } catch { /* missing pane / full disk: retry later, without restarting anything */ }
    }
  }
  return entries => {
    if (flight) return flight;
    const current = check(entries).finally(() => { if (flight === current) flight = null; });
    flight = current;
    return current;
  };
}
