import { setTimeout as sleep } from 'node:timers/promises';
import { agentInputReady, pendingDraftMatches } from './agent_input_ready.js';
import { stripAnsi } from './util.js';

// A folded paste temporarily REPLACES the permission footer with this hint.
// Keep this dialect confined to Claude; Codex's input contract is unchanged.
export const CLAUDE_COMPOSER_FOOTER = /bypass permissions|accept edits|plan mode|shift\+tab|⏸|← for agents|^\s*paste again to expand\b/i;

export function claudePaste(text) {
  // Literal send-keys can arrive in several reads and Claude may fold only the
  // first chunk. Bracketed paste keeps newlines and the entire input together.
  return `\x1b[200~${text}\x1b[201~`;
}

// Claude transforms ONE bracketed paste into several display chips (images, folded text, or both).
// These are a representation of our input, not another operator editing it. Only new chips in the
// live composer may authorize Enter; a chip is never, by itself, an acceptance receipt.
const CHIP = /\[(Image|Pasted (?:text|content))\s+#(\d+)(?:\s+\+\d+\s+lines?)?\]/gi;
const IMAGE_PATH = /(?:\/|[A-Za-z]:\\)[^\s"'<>]*?\.(?:png|jpe?g|gif|webp|bmp)(?=$|[\s"'<>),;])/gi;
const normalized = value => String(value || '').replace(/\s+/g, ' ').trim();
const chipKey = match => `${match[1].toLowerCase()}:${match[2]}`;
const draftViews = draft => [...new Set([draft?.text || '', draft?.lines?.join('') || ''].filter(Boolean))];

function inputImages(text) {
  const ranges = [];
  // Uploaded names commonly contain spaces. The attachment manifest gives an unambiguous path
  // through the end of the line; quoted inline paths are also unambiguous.
  for (const rx of [
    /^\d+\.[^\n]*?:[ \t]+((?:\/|[A-Za-z]:\\)[^\n]+\.(?:png|jpe?g|gif|webp|bmp))[ \t]*$/gim,
    /(["'])((?:\/|[A-Za-z]:\\)[^\n"']+\.(?:png|jpe?g|gif|webp|bmp))\1/gi,
  ]) for (const match of text.matchAll(rx)) {
    const path = match[2] || match[1];
    const start = match[2] ? match.index : match.index + match[0].indexOf(path);
    ranges.push({ start, end: start + (match[2] ? match[0].length : path.length) });
  }
  for (const match of text.matchAll(IMAGE_PATH)) {
    if (!ranges.some(range => match.index >= range.start && match.index < range.end)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  ranges.sort((a, b) => b.start - a.start);
  let withoutImages = text;
  for (const { start, end } of ranges) withoutImages = withoutImages.slice(0, start) + withoutImages.slice(end);
  return { count: ranges.length, withoutImages: normalized(withoutImages) };
}

// Linear wildcard match: folded chips stand for hidden text; visible text must still match in order,
// including both ends. Avoid a chain of .* regexes (and pathological backtracking on long messages).
function foldedPartsMatch(parts, wanted) {
  if (!wanted.startsWith(parts[0]) || !wanted.endsWith(parts.at(-1))) return false;
  let at = parts[0].length;
  const end = wanted.length - parts.at(-1).length;
  for (const part of parts.slice(1, -1)) {
    const found = wanted.indexOf(part, at);
    if (found < 0 || found + part.length > end) return false;
    at = found + part.length;
  }
  return at <= end;
}

export function claudeOwnedPaste({ draft, beforeDraft, text }) {
  const oldChips = new Set(draftViews(beforeDraft).flatMap(view => [...view.matchAll(CHIP)].map(chipKey)));
  const wanted = normalized(text);
  const { count: imageCount, withoutImages } = inputImages(String(text));
  for (const view of draftViews(draft)) {
    const chips = [...view.matchAll(CHIP)];
    if (!chips.length || chips.some(chip => oldChips.has(chipKey(chip)) || wanted.includes(chip[0]))) continue;
    const images = chips.filter(chip => chip[1].toLowerCase() === 'image');
    // Never interpret a leading image-only repaint as the complete message while text is still
    // arriving. Plain text around chips must match too; a foreign draft isn't a wildcard.
    if (images.length > imageCount || new Set(chips.map(chipKey)).size !== chips.length) continue;
    const visible = view.replace(/\[Image\s+#\d+\]/gi, '');
    const parts = visible.split(/\[Pasted (?:text|content)\s+#\d+(?:\s+\+\d+\s+lines?)?\]/gi).map(normalized);
    if (parts.length > 1) {
      if ([wanted, withoutImages].some(value => foldedPartsMatch(parts, value))) return true;
    } else if (pendingDraftMatches(normalized(visible), withoutImages)
      || (!normalized(visible) && !withoutImages && images.length === imageCount)) return true;
  }
  return false;
}

// Claude shows arbitrary model-generated prompt suggestions as DIM ghost text, not input. Plain
// capture loses that distinction. Retain SGR evidence until the live composer is located, remove
// only its dim suggestion spans, then trim tmux's bottom padding. Never normalize Codex this way.
export function normalizeClaudeInputScreen(screen) {
  const raw = String(screen || '').replace(/\r/g, '').split('\n');
  while (raw.length && !stripAnsi(raw.at(-1)).trim()) raw.pop();
  const lines = raw.map(stripAnsi);
  const footer = lines.findLastIndex(line => CLAUDE_COMPOSER_FOOTER.test(line));
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
    if (agentInputReady(normalizeClaudeInputScreen(await readScreen()), { completeComposer: true, footerPattern: CLAUDE_COMPOSER_FOOTER })) return true;
  } while (clock() < deadline);
  return false;
}
