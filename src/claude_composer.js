import { setTimeout as sleep } from 'node:timers/promises';
import { agentInputReady } from './agent_input_ready.js';
import { stripAnsi } from './util.js';

// Claude shows arbitrary model-generated prompt suggestions as DIM ghost text, not input. Plain
// capture loses that distinction. Retain SGR evidence until the live composer is located, remove
// only its dim suggestion spans, then trim tmux's bottom padding. Never normalize Codex this way.
export function normalizeClaudeInputScreen(screen) {
  const raw = String(screen || '').replace(/\r/g, '').split('\n');
  while (raw.length && !stripAnsi(raw.at(-1)).trim()) raw.pop();
  const lines = raw.map(stripAnsi);
  const footer = lines.findLastIndex(line => /bypass permissions|accept edits|plan mode|shift\+tab|⏸|← for agents/i.test(line));
  const rule = line => /^\s*[─━═╌╍┄┅┈┉⎯_-]{8,}\s*$/.test(line);
  const bottom = lines.findLastIndex((line, i) => i < footer && rule(line));
  const top = lines.findLastIndex((line, i) => i < bottom && rule(line));
  // Two frame rules prove the current input region, even when it contains quoted prompt glyphs.
  // A frameless legacy/fixture screen uses the nearest glyph below the last report instead.
  const start = top >= 0
    ? lines.findIndex((line, i) => i > top && i < bottom && /^\s*❯/.test(line))
    : lines.findLastIndex((line, i) => i < footer && /^\s*❯/.test(line));
  const end = bottom > start ? bottom : footer;
  if (start < 0 || footer < 0) return lines.join('\n');
  let dim = false;
  return raw.map((line, index) => {
    let text = '', at = 0;
    const sgr = /\x1b\[([0-9;]*)m/g;
    const append = value => { if (!(dim && index >= start && index < end)) text += value; };
    for (const match of line.matchAll(sgr)) {
      append(line.slice(at, match.index));
      const values = (match[1] || '0').split(';').map(Number);
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (value === 0 || value === 22) dim = false;
        else if (value === 2) dim = true;
        // RGB/indexed color payloads can contain 0/2/22; they are not SGR style commands.
        else if ([38, 48, 58].includes(value)) i += values[i + 1] === 2 ? 4 : values[i + 1] === 5 ? 2 : 0;
      }
      at = match.index + match[0].length;
    }
    append(line.slice(at));
    return stripAnsi(text);
  }).join('\n');
}

// Claude's Ctrl-U edits only the current logical line in recent builds. Ctrl-S stashes the
// WHOLE draft without interrupting work. It toggles restore on an empty composer, so press it
// exactly once and only for a positively identified nonempty draft. Never paste until it clears.
export async function stashClaudeComposer({ stash, readScreen, pause = sleep, clock = Date.now, timeoutMs = 1800 }) {
  const deadline = clock() + timeoutMs;
  await stash();
  do {
    await pause(80);
    if (agentInputReady(normalizeClaudeInputScreen(await readScreen()), { completeComposer: true })) return true;
  } while (clock() < deadline);
  return false;
}
