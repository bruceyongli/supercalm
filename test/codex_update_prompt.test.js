import assert from 'node:assert/strict';
import { codexUpdatePrompt, skipCodexUpdate } from '../src/codex_update_prompt.js';
import { agentInputReady } from '../src/agent_input_ready.js';
import { terminalQuestionPrompt, classify } from '../src/detect_classify.js';

const screen = '\n  Update available · 0.164.0 → 0.167.0\n'
  + '  Release notes: https://github.com/openai/codex/releases/latest\n\n'
  + '› 1. Update now (runs `npm install -g @openai/codex`)\n'
  + '  2. Skip\n  3. Skip until next version\n\n  enter continue · esc skip\n' + '\n'.repeat(45);
const composer = '› Ask Codex to do anything\n\nGPT-6.1-Sol max';
const parsed = codexUpdatePrompt(screen);
assert.equal(parsed.kind, 'codex-update');
assert.deepEqual(parsed.options.map(o => o.label), ['Update now (runs `npm install -g @openai/codex`)', 'Skip', 'Skip until next version']);
assert.deepEqual(parsed.options[1].keys, ['esc'], 'never accidentally install the highlighted update');
assert.deepEqual(terminalQuestionPrompt(screen), parsed, 'Story exposes the same native options');
assert.equal(agentInputReady(screen), false);
for (const autonomy of ['ask', 'auto', 'full']) {
  const result = classify({ session: { id: 'update-' + autonomy, tool: 'codex', autonomy }, snap: screen, idleMs: 0 });
  assert.equal(result.status, 'waiting');
  assert.match(result.question, /^Codex update available/);
  assert.equal(result.confirm, undefined, 'polling never types a skip/update key');
}
const lastSelected = screen.replace('› 1.', '  1.').replace('  3.', '› 3.');
assert.deepEqual(codexUpdatePrompt(lastSelected).options[1].keys, ['esc']);
assert.deepEqual(codexUpdatePrompt(lastSelected).options[0].keys, ['up', 'up', 'enter']);
assert.ok(codexUpdatePrompt(screen.replace('Update available', '\x1b[32mUpdate available\x1b[0m')));
assert.ok(codexUpdatePrompt(screen.replace('(runs `npm', '(runs\n `npm')), 'command wrapping remains an optional update');
assert.ok(codexUpdatePrompt(screen.replace('→ 0.167.0', '→\n  0.167.0')
  .replace('codex/releases/latest', 'codex/relea\n  ses/latest')), 'narrow mobile panes may wrap versions and the release URL');
for (const bad of [screen + composer, screen + '\nActual permission: approve? (y/n)',
  screen.replace('github.com/openai/codex', 'github.com/other/tool'),
  screen.replace('  2. Skip', '  2. Delete the project'), screen.replace('› 1.', '  1.'),
  screen.replace('  2. Skip', '› 2. Skip'), screen.replace('esc skip', 'esc quit'),
  'Update available. Please trust the project.', 'Choose one:\n› 1. Update now\n  2. Skip\nEnter to select',
]) assert.equal(codexUpdatePrompt(bad), null, 'unknown, quoted or ambiguous menus are inert');

let now = 0, keys = [], views = [], unchanged = true;
const run = (initial = screen, extra = {}) => skipCodexUpdate({ screen: initial,
  readScreen: async () => views.length > 1 ? views.shift() : views[0] || '',
  pressEscape: async () => { keys.push('esc'); }, inputUnchanged: () => unchanged,
  isReady: agentInputReady, clock: () => now, pause: async ms => { now += ms; }, timeoutMs: 500, ...extra });
views = [screen, '', 'Loading session…', composer];
let result = await run();
assert.equal(result.screen, composer); assert.equal(result.skipped, true); assert.deepEqual(keys, ['esc']);
assert.ok(now >= 250, 'waits through empty and loading frames before allowing a paste');
keys = []; views = [composer];
assert.equal((await run()).skipped, false); assert.deepEqual(keys, [], 'a modal that disappears before the fresh capture receives no keys');
views = [screen]; unchanged = false;
assert.equal((await run()).reason, 'input-changed'); assert.deepEqual(keys, []);
unchanged = true; now = 0;
result = await run(screen, { readScreen: async () => { unchanged = false; return screen; } });
assert.equal(result.reason, 'input-changed'); assert.deepEqual(keys, [], 'edit during capture prevents Escape');
unchanged = true;
result = await run(screen, { pressEscape: async () => { keys.push('esc'); unchanged = false; } });
assert.equal(result.reason, 'input-changed'); assert.equal(result.skipped, true);
unchanged = true; keys = []; now = 0; views = [screen];
result = await run();
assert.equal(result.reason, 'agent-starting'); assert.deepEqual(keys, ['esc'], 'ignored Escape is not repeated blindly');
keys = []; views = ['Trust this folder?\n› 1. Trust and continue\n  2. Quit\nenter continue · esc quit'];
result = await run();
assert.equal(result.skipped, false); assert.deepEqual(keys, [], 'new trust/permission gate is never answered');
console.log('codex_update_prompt: exact live menu, Story choices, one-shot skip, loading wait and raw-input fence passed');
