import { cleanAgentScreen } from './agent_input_ready.js';

const releaseUrl = 'https://github.com/openai/codex/releases/latest'
  .split('').map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
const updateShape = new RegExp('^Update available · ([\\w.+-]+) → ([\\w.+-]+) Release notes: '
  + releaseUrl + ' ([›>] )?1\\. (Update now \\(runs `[^`]+`\\)) ([›>] )?2\\. (Skip) ([›>] )?3\\. (Skip until next version) enter continue · esc skip$', 'i');

// A startup selector, not a model question or permission request. Require the complete native
// shape at the visible end of the pane; a report quoting it above a composer must remain inert.
export function codexUpdatePrompt(screen) {
  const lines = cleanAgentScreen(screen).trimEnd().split('\n').slice(-32).map(line => line.trim());
  if (!/^enter continue\s*·\s*esc skip$/i.test(lines.at(-1) || '')) return null;
  const at = lines.findLastIndex(line => /^Update available\s*·/.test(line));
  if (at < 0) return null;
  // Whitespace normalization also handles narrow terminals wrapping the release URL/update command.
  const body = lines.slice(at).join(' ').replace(/\s+/g, ' ').trim();
  const match = body.match(updateShape);
  if (!match) return null;
  const options = [
    { label: match[4], selected: !!match[3] },
    { label: match[6], selected: !!match[5] },
    { label: match[8], selected: !!match[7] },
  ];
  if (options.filter(option => option.selected).length !== 1) return null;
  const selected = options.findIndex(option => option.selected);
  return {
    kind: 'codex-update', from: match[1], to: match[2],
    question: `Codex update available · ${match[1]} → ${match[2]}`,
    options: options.map((option, index) => ({ ...option, keys: index === 1 ? ['esc'] : [
      ...Array.from({ length: Math.abs(index - selected) }, () => index > selected ? 'down' : 'up'), 'enter',
    ] })),
  };
}

// Only called inside the operator-send lease. Skip this optional update once, without installing
// software, changing preferences, approving a gate, or restarting the native conversation. Re-read
// immediately before Escape and wait for a real input target; an empty/loading frame is not ready.
export async function skipCodexUpdate({ screen, readScreen, pressEscape, inputUnchanged, isReady,
  timeoutMs = 8000, clock = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!codexUpdatePrompt(screen)) return { screen, skipped: false };
  if (!inputUnchanged()) return { screen, skipped: false, reason: 'input-changed' };
  screen = await readScreen();
  const prompt = codexUpdatePrompt(screen);
  if (!inputUnchanged()) return { screen, skipped: false, reason: 'input-changed' };
  if (!prompt) return { screen, skipped: false };
  await pressEscape();
  const deadline = clock() + timeoutMs;
  do {
    if (!inputUnchanged()) return { screen, skipped: true, prompt, reason: 'input-changed' };
    screen = await readScreen();
    if (!inputUnchanged()) return { screen, skipped: true, prompt, reason: 'input-changed' };
    if (!codexUpdatePrompt(screen) && isReady(screen)) return { screen, skipped: true, prompt };
    if (clock() >= deadline) break;
    await pause(125);
  } while (true);
  return { screen, skipped: true, prompt, reason: 'agent-starting' };
}
