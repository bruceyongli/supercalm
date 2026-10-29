import { cleanAgentScreen } from './agent_input_ready.js';

export const codexPaste = text => `\x1b[200~${text}\x1b[201~`;

// Codex 0.164 scrolls *inside* a tall composer, keeping › at the first visible row. The screen
// then contains a suffix, not the full input. This is evidence only for the paste we just owned;
// never use it to guess the contents of a pre-existing draft or as an acceptance receipt.
export function codexOwnedPaste({ draft, beforeDraft, text, screen }) {
  if (!draft || beforeDraft) return false;
  const view = draft.text;
  const folded = view.match(/^\[Pasted Content (\d+) chars\]$/i);
  if (folded) return Number(folded[1]) === [...String(text)].length;
  const oldFold = view.match(/^\[Pasted (?:text|content) #\d+ \+(\d+) lines?\]$/i);
  if (oldFold) return Number(oldFold[1]) === String(text).split('\n').length - 1;
  const lines = cleanAgentScreen(screen).split('\n');
  const marker = lines.findIndex(line => /^\s*›\s+/.test(line));
  const footer = lines.findLastIndex(line => /^\s*(?:gpt-[\w.-]+|\d+% context left)/i.test(line));
  // A cropped Codex composer fills its viewport. Short/arbitrary excerpts or a transcript prompt
  // above an empty composer do not qualify. Raw terminal edits additionally invalidate ownership.
  if (marker < 0 || marker > 3 || footer < lines.length - 4 || footer - marker < 6
      || (draft.lines?.length || 0) < 3 || view.length < 64) return false;
  const wanted = String(text).replace(/\s+/g, ' ').trim();
  let end = wanted.length;
  // Match backwards once. Searching every possible prefix in a repetitive long paste is quadratic.
  for (const line of [...draft.lines].reverse()) {
    const part = String(line).replace(/\s+/g, ' ').trim();
    if (end < part.length || wanted.slice(end - part.length, end) !== part) return false;
    end -= part.length;
    while (end > 0 && wanted[end - 1] === ' ') end--;
  }
  return end > 0;
}
