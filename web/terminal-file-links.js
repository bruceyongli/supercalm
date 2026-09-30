import { fileReferences, localFilePath, hasKnownFileExtension } from './file-reference.js';

// CLI renderers also insert hard newlines plus indentation inside paths, so xterm's isWrapped alone
// isn't enough (and a reconnect snapshot loses that flag entirely). Only stitch an unfinished path
// token to a filename-like continuation. Complete files and separate absolute paths stay separate.
function pathContinuation(before, after, inTable = false) {
  const tail = before.trimEnd().match(/(?:^|[\s([{<"'`])((?:https?:\/\/|file:\/\/|~?\/|\.{1,2}\/|[\p{L}\p{N}_@+-]+\/)[^\s<>()"'`,;]*)$/u)?.[1]
    || before.trimEnd().match(/["'`(<]((?:file:\/\/|~?\/|\.{1,2}\/|[\p{L}\p{N}_@+-]+\/)[^<>"'`]+)$/u)?.[1];
  if (!tail) return false;
  const local = localFilePath(tail);
  // External URLs have no reliable hard-line continuation marker (an extensionless URL may already
  // be complete). Native soft wraps are still joined, but don't absorb following prose into a URL.
  if (/^https?:\/\//i.test(tail) && !local && !inTable) return false;
  const head = (inTable ? after.trimStart() : after).match(/^ {0,8}([\p{L}\p{N}_.@+%:#?=&-][\p{L}\p{N}_./@+%:#?=&-]*)/u);
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
    for (let n = 0; n < value.length; n++) cells.push({ x: x + 1, y: index + 1, endX: x + Math.max(1, cell.getWidth()), column: x + 1 });
    if (chars) used = text.length;
  }
  // Drop unused padding, but retain literal spaces at a soft-wrap boundary.
  return { text: text.slice(0, used), cells: cells.slice(0, used), wrapped: line.isWrapped };
}

function tableColumns(row) {
  // Codex draws separate horizontal rules for borderless Markdown table cells;
  // other CLIs use ASCII/box borders. Those rules are display columns, NOT JS
  // string offsets (wide characters before a path still occupy two cells).
  if (!/^[\s|+│┃║─━═┬┼┴┌┐└┘├┤╭╮╰╯╪╤╧:-]+$/.test(row.text)) return null;
  const runs = [...row.text.matchAll(/[─━═-]{3,}/g)];
  if (runs.length < 2) return null;
  return runs.map(run => ({ start: row.cells[run.index].column,
    end: row.cells[run.index + run[0].length - 1].column + 1 }));
}

function tableCell(row, column) {
  const indices = row.cells.map((cell, i) => cell.column >= column.start && cell.column < column.end ? i : -1).filter(i => i >= 0);
  const first = indices[0], end = indices.at(-1) + 1;
  return { ...row, text: first == null ? '' : row.text.slice(first, end), cells: first == null ? [] : row.cells.slice(first, end), table: true };
}

export function terminalFileReferences(term, bufferLineNumber) {
  const buffer = term.buffer.active;
  const row = bufferLineNumber - 1;
  const cols = term.cols;
  if (row < 0 || row >= buffer.length || !cols) return [];
  // Bound hover work even for a pathological terminal line; ordinary long paths fit in this window.
  const first = Math.max(0, row - 16);
  const last = Math.min(buffer.length - 1, row + 16);
  const rows = [];
  for (let y = first; y <= last; y++) {
    const next = readRow(buffer, y, cols);
    if (!next) break;
    const prior = rows.at(-1);
    if (prior && next.wrapped) {
      const offset = (y + 1 - prior.first) * cols;
      prior.text += next.text;
      prior.cells.push(...next.cells.map(cell => ({ ...cell, column: cell.column + offset })));
      prior.last = y + 1;
    } else rows.push({ ...next, first: y + 1, last: y + 1 });
  }
  // Walk each table column independently. Joining entire display rows would
  // splice the next column's link into this one, exactly the operator's report.
  const streams = [[]];
  let columns = null, columnStreams = null;
  for (const row of rows) {
    const detected = tableColumns(row);
    if (detected) { columns = detected; columnStreams = columns.map(() => []); streams.push(...columnStreams); streams[0].push(null); continue; }
    const fits = columns && row.text.trim() && row.cells.every((cell, i) => /[\s|│┃║]/.test(row.text[i]) || columns.some(c => cell.column >= c.start && cell.column < c.end));
    if (fits) columns.forEach((column, i) => columnStreams[i].push(tableCell(row, column)));
    else { columns = null; columnStreams = null; streams[0].push(row); }
  }
  const groups = [];
  for (const stream of streams) {
    let group = null;
    for (const next of stream) {
      if (!next) { group = null; continue; }
      const continuation = group && next.text.trim() && pathContinuation(group.text, next.text, next.table);
      if (group && continuation) {
        // CLI-indented hard wraps are layout; soft wraps retain every printed character.
        const skip = next.text.length - next.text.trimStart().length;
        const end = group.text.trimEnd().length;
        group.text = group.text.slice(0, end);
        group.cells.length = end;
        group.text += next.text.slice(skip);
        group.cells.push(...next.cells.slice(skip));
        group.last = next.last;
      } else {
        group = { ...next, cells: [...next.cells] };
        groups.push(group);
      }
    }
  }

  const links = [];
  for (const candidate of groups) {
    if (candidate.first > bufferLineNumber || candidate.last < bufferLineNumber) continue;
    for (const match of fileReferences(candidate.text)) {
      const raw = match.text;
      if (!raw) continue;
      // xterm's multi-row range covers whole intervening rows. A table link must
      // instead expose one hitbox per physical fragment, leaving other cells free.
      const cells = candidate.cells.slice(match.index, match.index + raw.length).filter(cell => cell.y === bufferLineNumber);
      const start = cells[0], end = cells.at(-1);
      if (!start || !end) continue;
      links.push({
        text: raw,
        range: { start: { x: start.x, y: start.y }, end: { x: end.endX, y: end.y } },
      });
    }
  }
  return links;
}

// Touch has no prior mouse-hover phase for xterm's asynchronous linkifier. Resolve
// the cell at tap time; suppress its synthetic click and the composer-focus hook.
export function installTerminalLinkTaps({ element, term, activate, isScrolling = () => false, signal }) {
  let tap = null, suppress = null;
  const pointers = new Set();
  const options = { capture: true, passive: false, signal };
  element.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') return;
    pointers.add(event.pointerId);
    tap = pointers.size === 1 ? { id: event.pointerId, x: event.clientX, y: event.clientY, at: Date.now(), moved: false } : null;
  }, options);
  element.addEventListener('pointermove', event => {
    if (tap && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 8) tap.moved = true;
  }, options);
  element.addEventListener('pointercancel', event => { pointers.delete(event.pointerId); tap = null; }, options);
  element.addEventListener('pointerup', event => {
    pointers.delete(event.pointerId);
    const start = tap; tap = null;
    if (!start || event.pointerId !== start.id || start.moved || pointers.size || isScrolling() || Date.now() - start.at > 600) return;
    const rect = element.querySelector('.xterm-screen')?.getBoundingClientRect();
    if (!rect?.width || !rect?.height) return;
    const x = Math.floor((event.clientX - rect.left) * term.cols / rect.width) + 1;
    const y = Math.floor((event.clientY - rect.top) * term.rows / rect.height) + 1 + term.buffer.active.viewportY;
    const link = terminalFileReferences(term, y).find(ref => x >= ref.range.start.x && x <= ref.range.end.x);
    if (!link) return;
    event.preventDefault(); event.stopImmediatePropagation();
    suppress = { x: event.clientX, y: event.clientY, until: Date.now() + 800 };
    activate(link, event);
  }, options);
  for (const type of ['mousedown', 'mouseup', 'click']) element.addEventListener(type, event => {
    if (suppress && Date.now() < suppress.until && Math.hypot(event.clientX - suppress.x, event.clientY - suppress.y) < 8) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (type === 'click') suppress = null;
    }
  }, options);
}
