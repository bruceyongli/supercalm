import { setTimeout as sleep } from 'node:timers/promises';
import { agentInputReady } from './agent_input_ready.js';

// Claude's Ctrl-U edits only the current logical line in recent builds. Ctrl-S stashes the
// WHOLE draft without interrupting work. It toggles restore on an empty composer, so press it
// exactly once and only for a positively identified nonempty draft. Never paste until it clears.
export async function stashClaudeComposer({ stash, readScreen, pause = sleep, clock = Date.now, timeoutMs = 1800 }) {
  const deadline = clock() + timeoutMs;
  await stash();
  do {
    await pause(80);
    if (agentInputReady(await readScreen(), { completeComposer: true })) return true;
  } while (clock() < deadline);
  return false;
}
