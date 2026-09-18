import { FILE_REFERENCE_RX, cleanFileReference, localFilePath, hasKnownFileExtension } from './file-reference.js';

// CLI renderers also insert hard newlines plus indentation inside paths, so xterm's isWrapped alone
// isn't enough (and a reconnect snapshot loses that flag entirely). Only stitch an unfinished path
// token to a filename-like continuation. Complete files and separate absolute paths stay separate.
function pathContinuation(before, after) {
  const tail = before.trimEnd().match(/(?:^|[\s([{<"'`])((?:https?:\/\/|file:\/\/|~?\/|\.{1,2}\/|[\w@+-]+\/)[^\s<>()"'`,;]*)$/)?.[1];
  if (!tail) return false;
  const local = localFilePath(tail);
  // External URLs have no reliable hard-line continuation marker (an extensionless URL may already
  // be complete). Native soft wraps are still joined, but don't absorb following prose into a URL.
  if (/^https?:\/\//i.test(tail) && !local) return false;
  const head = after.match(/^ {0,8}([\w.@+%:#?=&-][\w./@+%:#?=&-]*)/);
  if (!head) return false;
  const path = local || tail;
  // A wrap can even split an extension: .js + on, or .c + ss. Otherwise an already complete
  // filename ends the link; never glue the next line's filename or prose onto it.
  if (hasKnownFileExtension(path)) {
    return /^[A-Za-z0-9]+$/.test(head[1]) && hasKnownFileExtension(path + head[1]);
  }
  return true;
}

// Offsets in a JS string are not terminal columns: CJK takes two cells, and emoji/combining sequences
// can contain several code units in one cell. Keep the real cell location for every matched code unit.
function readRow(buffer, index, cols) {
  const line = buffer.getLine(index);
  if (!line) return null;
  let text = '';
  const cells = [];
  let used = 0;
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars();
    const value = chars || ' ';
    text += value;
    for (let n = 0; n < value.length; n++) cells.push({ x: x + 1, y: index + 1, endX: x + Math.max(1, cell.getWidth()) });
    if (chars) used = text.length;
  }
  // Drop unused padding, but retain literal spaces at a soft-wrap boundary.
  return { text: text.slice(0, used), cells: cells.slice(0, used), wrapped: line.isWrapped };
}

export function terminalFileReferences(term, bufferLineNumber) {
  const buffer = term.buffer.active;
  const row = bufferLineNumber - 1;
  const cols = term.cols;
  if (row < 0 || row >= buffer.length || !cols) return [];
  // Bound hover work even for a pathological terminal line; ordinary long paths fit in this window.
  const first = Math.max(0, row - 16);
  const last = Math.min(buffer.length - 1, row + 16);
  const groups = [];
  let group = null;
  for (let y = first; y <= last; y++) {
    const next = readRow(buffer, y, cols);
    if (!next) break;
    const continuation = group && next.text.trim() && pathContinuation(group.text, next.text);
    if (group && (next.wrapped || continuation)) {
      // CLI-indented hard wraps are layout; soft wraps retain every printed character.
      const skip = next.wrapped ? 0 : next.text.length - next.text.trimStart().length;
      if (!next.wrapped) {
        const end = group.text.trimEnd().length;
        group.text = group.text.slice(0, end);
        group.cells.length = end;
      }
      group.text += next.text.slice(skip);
      group.cells.push(...next.cells.slice(skip));
      group.last = y + 1;
    } else {
      group = { text: next.text, cells: next.cells, first: y + 1, last: y + 1 };
      groups.push(group);
    }
  }

  const links = [];
  for (const candidate of groups) {
    if (candidate.first > bufferLineNumber || candidate.last < bufferLineNumber) continue;
    for (const match of candidate.text.matchAll(new RegExp(FILE_REFERENCE_RX.source, 'g'))) {
      const raw = cleanFileReference(match[0]);
      if (!raw) continue;
      const start = candidate.cells[match.index];
      const end = candidate.cells[match.index + raw.length - 1];
      if (!start || !end || start.y > bufferLineNumber || end.y < bufferLineNumber) continue;
      links.push({
        text: raw,
        range: { start: { x: start.x, y: start.y }, end: { x: end.endX, y: end.y } },
      });
    }
  }
  return links;
}
