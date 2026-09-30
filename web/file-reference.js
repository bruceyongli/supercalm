// Turn a path or a URL pointing at this AIOS host into the host-local path that the session file
// viewer expects. Full host URLs appear frequently in agent reports because root paths are useful in
// terminals, but navigating to them bypasses AIOS's /aios route and produces a 404.
export function cleanFileReference(value) {
  let ref = String(value || '').trim()
    .replace(/^[('"`\[<{]+/, '')
    .replace(/['"`>.,;:]+$/, '')
    .trim();
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    while (ref.endsWith(close) && ref.split(close).length > ref.split(open).length) ref = ref.slice(0, -1);
  }
  return ref;
}

function withoutSourceLocation(value) {
  return String(value || '')
    .replace(/#L\d+(?:C\d+)?$/i, '')
    .replace(/:\d+(?::\d+)?$/, '');
}

function decodedPathname(url) {
  try { return withoutSourceLocation(decodeURIComponent(url.pathname)); } catch { return ''; }
}

export function localFilePath(value, currentHostname = globalThis.location?.hostname || '') {
  const ref = cleanFileReference(value);
  if (!ref) return '';
  if (/^https?:\/\//i.test(ref) || ref.startsWith('//')) {
    try {
      const url = new URL(ref.startsWith('//') ? `https:${ref}` : ref);
      if (!currentHostname || url.hostname !== currentHostname) return '';
      return decodedPathname(url);
    } catch {
      return '';
    }
  }
  if (/^file:\/\//i.test(ref)) {
    try {
      const url = new URL(ref);
      if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return '';
      return decodedPathname(url);
    } catch {
      return '';
    }
  }
  if (ref.includes('://')) return '';
  const path = hasKnownFileExtension(ref.split('#')[0]) ? ref.split('#')[0] : ref;
  try { return withoutSourceLocation(decodeURIComponent(path)); } catch { return withoutSourceLocation(path); }
}

export const FILE_REFERENCE_RX = /(?:https?|file):\/\/[^\s<>()"'`]+|[\w./@~+-]*\w\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?/g;

const FILE_TOKEN_EXTS = new Set(['md','markdown','txt','text','json','jsonc','yml','yaml','toml','ini','env','js','mjs','cjs','ts','tsx','jsx','py','go','rs','rb','java','kt','c','h','cc','cpp','hpp','cs','php','swift','css','scss','less','html','htm','xml','vue','svelte','sh','bash','zsh','sql','csv','tsv','log','svg','lock','png','jpg','jpeg','gif','webp','pdf','mp4','m4v','mov','webm','ogv']);
export function hasKnownFileExtension(raw) {
  const path = withoutSourceLocation(raw).split(/[?#]/)[0];
  if (!(path.split('/').pop() || '').includes('.')) return false;
  const ext = (path.split('.').pop() || '').toLowerCase();
  return FILE_TOKEN_EXTS.has(ext);
}

export function isFileReference(value, currentHostname = globalThis.location?.hostname || '') {
  const ref = cleanFileReference(value);
  if (!ref || ref.startsWith('#')) return false;
  const path = localFilePath(ref, currentHostname);
  // Rendered URLs and API downloads already ARE web routes, not paths on disk.
  if (!path || /^(?:\/aios(?:\/|$)|\/?api\/)/i.test(path)) return false;
  if (/^(?:https?:)?\/\//i.test(ref)) return hasKnownFileExtension(path) || /^\/(?:private\/)?tmp\//.test(path);
  if (/^[a-z][a-z\d+.-]*:/i.test(ref) && !/^file:\/\//i.test(ref)
    && !(/^[^:]+:\d+(?::\d+)?$/.test(ref) && hasKnownFileExtension(withoutSourceLocation(ref)))) return false;
  return path.includes('/') || hasKnownFileExtension(path) || /^(?:README|LICENSE|Dockerfile|Makefile|\.env|\.gitignore)$/i.test(path);
}

// Shared lexical coverage for terminal output and text/Markdown reports. Quoted
// paths can contain spaces; bare paths stop at whitespace. Keep exact offsets so
// the terminal provider can map Unicode text back to real screen cells.
export function fileReferences(value) {
  const text = String(value || ''), found = [];
  const add = (raw, index) => {
    const clean = cleanFileReference(raw);
    if (!clean || (!/^(?:https?:|file:)?\/\//i.test(clean) && !isFileReference(clean))) return;
    if (!/^(?:https?:|file:)?\/\//i.test(clean) && !hasKnownFileExtension(clean)
      && !/^(?:README|LICENSE|Dockerfile|Makefile|\.env|\.gitignore)$/i.test(clean.split('/').pop())) return;
    if (found.some(ref => index < ref.index + ref.text.length && index + clean.length > ref.index)) return;
    found.push({ text: clean, index: index + raw.indexOf(clean) });
  };
  for (const m of text.matchAll(/(["'`])([^\n"'`]+)\1|<([^<>\n]+)>/g)) {
    const raw = m[2] || m[3];
    if (/^(?:https?:\/\/|file:\/\/|~?\/|\.{1,2}\/|[^\s/]+\/)/i.test(raw) || (!raw.includes('/') && hasKnownFileExtension(raw))) add(raw, m.index + 1);
  }
  const rx = /(?:https?:\/\/|file:\/\/|\/\/)[^\s\x00<>"'`|]+|[~\p{L}\p{N}_./@%+-][~\p{L}\p{N}_./@%+()-]*(?::\d+(?::\d+)?)?(?:#L\d+(?:C\d+)?)?/gu;
  for (const m of text.matchAll(rx)) {
    if (m.index && /[\p{L}\p{N}_:$]/u.test(text[m.index - 1])) continue;
    add(m[0], m.index);
  }
  return found.sort((a, b) => a.index - b.index);
}
