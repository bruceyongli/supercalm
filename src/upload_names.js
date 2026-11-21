import { extname } from 'node:path';

// A user-facing filename is not a storage key. Retain Unicode, spaces and punctuation;
// discard directory components and invisible controls that could forge a manifest line.
export function attachmentName(value) {
  const leaf = String(value || '').toWellFormed().split(/[\\/]/).at(-1)
    .replace(/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g, '');
  return leaf.trim() && !/^\.{1,2}$/.test(leaf.trim()) ? leaf : 'attachment';
}

export function storageName(prefix, displayName) {
  const name = attachmentName(displayName).trimEnd(); // CLI paths are line-delimited; label remains verbatim
  const budget = 255 - Buffer.byteLength(prefix);
  if (Buffer.byteLength(name) <= budget) return prefix + name;
  const ext = extname(name);
  const suffix = Buffer.byteLength(ext) <= 32 ? ext : '';
  let used = Buffer.byteLength(suffix), stem = '';
  for (const char of (suffix ? name.slice(0, -suffix.length) : name)) {
    used += Buffer.byteLength(char);
    if (used > budget) break;
    stem += char;
  }
  return prefix + stem + suffix;
}

export function textWithAttachmentBlock(text, attachments) {
  const base = String(text || '').trim();
  if (!attachments.length) return base;
  const lines = attachments.map((a, i) => {
    const kind = a.isImage ? 'image' : 'file';
    const bits = [a.format, a.type || kind].filter(Boolean).join(', ');
    return `${i + 1}. ${a.name}${bits ? ` (${bits})` : ''}: ${a.path}`;
  });
  const lead = base || 'Please review the attached files/images.';
  return `${lead}\n\nAttached files available locally to this coding CLI:\n${lines.join('\n')}\n\nOpen these paths directly when you need the uploaded content.`;
}
