import { fileReferences, isFileReference } from './file-reference.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function safeLinkHref(value) {
  const href = String(value || '').trim();
  if (!href || /[\x00-\x1f\x7f<>]/.test(href)) return null;
  if (/^(?:https?:|mailto:|#)/i.test(href)) return href;
  if (/^file:\/\/(?:localhost)?\//i.test(href)) return href;
  if (href.includes(':') && !(/^[^:]+:\d+(?::\d+)?$/.test(href) && isFileReference(href))) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !isFileReference(href)) return null;
  return href;
}
function anchor(href, label, options) {
  const safe = safeLinkHref(href);
  if (!safe) return null;
  const mapped = options?.linkHref ? options.linkHref(safe) : safe;
  if (!mapped) return label;
  return `<a href="${esc(mapped)}" target="_blank" rel="noopener noreferrer">${label || esc(safe)}</a>`;
}
export function renderLinkedText(value, options = {}) {
  const text = String(value || '');
  let out = '', end = 0;
  for (const ref of fileReferences(text)) {
    if (options.urls === false && /^(?:https?:)?\/\//i.test(ref.text)) continue;
    const html = anchor(ref.target || ref.text, esc(ref.text), options);
    if (!html) continue;
    out += esc(text.slice(end, ref.index)) + html;
    end = ref.index + ref.text.length;
  }
  return out + esc(text.slice(end));
}
export function markdownDestination(value) {
  const text = value.trim();
  const match = text.startsWith('<') ? text.match(/^<([^>]+)>(?:\s+["'][\s\S]*["'])?$/)
    : text.match(/^([\s\S]*?)(?:\s+["'][^\n]*["'])?$/);
  return match ? match[1].replace(/\\([\\()[\]<> ])/g, '$1') : '';
}
function closing(text, start, open, close) {
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === open) depth++;
    if (text[i] === close && --depth === 0) return i;
  }
  return -1;
}
const refKey = value => value.trim().replace(/\s+/g, ' ').toLowerCase();
export function renderInline(value, options = {}) {
  const text = String(value || '').replace(/\x00/g, '');
  const slots = [];
  let plain = '', i = 0;
  const token = html => `\x00${slots.push(html) - 1}\x00`;
  while (i < text.length) {
    if (text[i] === '\\' && /[\[\]()`*_|]/.test(text[i + 1] || '')) { plain += token(esc(text[i + 1])); i += 2; continue; }
    if (text[i] === '`') {
      const ticks = text.slice(i).match(/^`+/)[0];
      const end = text.indexOf(ticks, i + ticks.length);
      if (end >= 0) {
        const code = text.slice(i + ticks.length, end);
        const wholePath = isFileReference(code) && /^(?:file:\/\/|~?\/|\.{1,2}\/|[^\s/]+\/)/.test(code);
        const linked = wholePath ? anchor(code, esc(code), options) : null;
        plain += token(`<code>${linked || renderLinkedText(code, {...options, urls: false})}</code>`);
        i = end + ticks.length; continue;
      }
    }
    if (text[i] === '<') {
      const end = text.indexOf('>', i + 1), href = text.slice(i + 1, end);
      if (end >= 0 && (/^(?:https?:|mailto:|file:)\/\//i.test(href) || isFileReference(href))) {
        const link = anchor(href, esc(href), options);
        if (link) { plain += token(link); i = end + 1; continue; }
      }
    }
    const start = text[i] === '!' && text[i + 1] === '[' ? i + 1 : i;
    if (text[start] === '[') {
      const labelEnd = closing(text, start, '[', ']');
      if (labelEnd >= 0) {
        const label = text.slice(start + 1, labelEnd);
        let end = labelEnd, href;
        if (text[end + 1] === '(') {
          const targetEnd = closing(text, end + 1, '(', ')');
          if (targetEnd >= 0) { href = markdownDestination(text.slice(end + 2, targetEnd)); end = targetEnd; }
        } else if (text[end + 1] === '[') {
          const refEnd = text.indexOf(']', end + 2);
          if (refEnd >= 0) { href = options.references?.get(refKey(text.slice(end + 2, refEnd) || label)); end = refEnd; }
        } else href = options.references?.get(refKey(label));
        if (href) {
          const link = anchor(href, esc(label).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'), options);
          if (link) { plain += token(link); i = end + 1; continue; }
          // Invalid schemes stay literal, never autolink a substring of them.
          plain += token(esc(text.slice(i, end + 1))); i = end + 1; continue;
        }
      }
    }
    plain += text[i++];
  }
  // Reserve all generated anchors before applying emphasis so formatting cannot
  // rewrite href attributes or create nested anchors inside existing links.
  const linked = fileReferences(plain);
  for (const ref of linked.reverse()) {
    const link = anchor(ref.target || ref.text, esc(ref.text), options);
    if (link) plain = plain.slice(0, ref.index) + token(link) + plain.slice(ref.index + ref.text.length);
  }
  return esc(plain).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/\x00(\d+)\x00/g, (_, index) => slots[Number(index)]);
}

export function markdownTableCells(line) {
  const text = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  const cells = []; let cell = '', ticks = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') { cell += '|'; i++; continue; }
    if (text[i] === '`') {
      const run = text.slice(i).match(/^`+/)[0]; ticks = ticks === run ? '' : ticks || run;
      cell += run; i += run.length - 1; continue;
    }
    if (text[i] === '|' && !ticks) { cells.push(cell.trim()); cell = ''; } else cell += text[i];
  }
  cells.push(cell.trim()); return cells;
}
