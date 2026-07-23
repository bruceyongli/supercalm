// Turn a path or a URL pointing at this AIOS host into the host-local path that the session file
// viewer expects. Full host URLs appear frequently in agent reports because root paths are useful in
// terminals, but navigating to them bypasses AIOS's /aios route and produces a 404.
export function cleanFileReference(value) {
  return String(value || '')
    .replace(/^[('"`\[<{]+/, '')
    .replace(/[)'"`\]>}.,;:]+$/, '')
    .trim();
}

export function localFilePath(value, currentHostname = globalThis.location?.hostname || '') {
  const ref = cleanFileReference(value);
  if (!ref) return '';
  if (/^https?:\/\//i.test(ref) || ref.startsWith('//')) {
    try {
      const url = new URL(ref.startsWith('//') ? `https:${ref}` : ref);
      if (!currentHostname || url.hostname !== currentHostname) return '';
      return decodeURIComponent(url.pathname);
    } catch {
      return '';
    }
  }
  return ref.includes('://') ? '' : ref;
}

export const FILE_REFERENCE_RX = /https?:\/\/[^\s<>()"'`]+|[\w./@~+-]*\w\.[A-Za-z0-9]{1,10}/g;
