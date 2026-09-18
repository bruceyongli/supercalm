// Turn a path or a URL pointing at this AIOS host into the host-local path that the session file
// viewer expects. Full host URLs appear frequently in agent reports because root paths are useful in
// terminals, but navigating to them bypasses AIOS's /aios route and produces a 404.
export function cleanFileReference(value) {
  return String(value || '')
    .replace(/^[('"`\[<{]+/, '')
    .replace(/[)'"`\]>}.,;:]+$/, '')
    .trim();
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
  return ref.includes('://') ? '' : withoutSourceLocation(ref);
}

export const FILE_REFERENCE_RX = /(?:https?|file):\/\/[^\s<>()"'`]+|[\w./@~+-]*\w\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?/g;

const FILE_TOKEN_EXTS = new Set(['md','markdown','txt','text','json','jsonc','yml','yaml','toml','ini','env','js','mjs','cjs','ts','tsx','jsx','py','go','rs','rb','java','kt','c','h','cc','cpp','hpp','cs','php','swift','css','scss','less','html','htm','xml','vue','svelte','sh','bash','zsh','sql','csv','tsv','log','svg','lock','png','jpg','jpeg','gif','webp','pdf','mp4','m4v','mov','webm','ogv']);
export function hasKnownFileExtension(raw) {
  const path = String(raw || '').split(/[?#]/)[0];
  const ext = (path.split('.').pop() || '').toLowerCase();
  return FILE_TOKEN_EXTS.has(ext);
}
