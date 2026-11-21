// Snapshot drag-store handles and names during the event. Safari can expose a file through
// FileList, getAsFile(), or a file entry; these are views of one drop, not separate uploads.
const leaf = value => String(value || '').split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g, '');
const ext = name => /\.([a-z0-9]{1,12})$/i.exec(name || '')?.[1].toLowerCase() || '';
const generic = name => !name || /^(?:image|file|blob|untitled|pasted[ -]image|[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\.[^.]+)?$/i.test(name);
const read = fn => { try { return fn(); } catch { return null; } };
const types = {
  png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml',
  avif:'image/avif', heic:'image/heic', heif:'image/heif', bmp:'image/bmp', tif:'image/tiff', tiff:'image/tiff', ico:'image/x-icon',
  pdf:'application/pdf', wav:'audio/wav', wave:'audio/wav', mp3:'audio/mpeg', m4a:'audio/mp4', aac:'audio/aac',
  ogg:'audio/ogg', oga:'audio/ogg', opus:'audio/opus', flac:'audio/flac', aif:'audio/aiff', aiff:'audio/aiff',
  mp4:'video/mp4', m4v:'video/mp4', mov:'video/quicktime', webm:'video/webm', ogv:'video/ogg',
  txt:'text/plain', md:'text/markdown', csv:'text/csv', json:'application/json', zip:'application/zip',
  docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const textExt = /^(?:markdown|jsonl|ndjson|tsv|log|yaml|yml|toml|ini|html?|xml|css|jsx?|mjs|cjs|tsx?|py|rb|go|rs|sh|java|sql|c|cpp|h|diff|patch)$/;
const knownType = type => (type || '').toLowerCase().split(';')[0].trim().replace(/^(?:application\/octet-stream|binary\/octet-stream)$/, '');
const nameType = name => types[ext(name)] || (textExt.test(ext(name)) ? 'text/plain' : '');

function namedFile(file, listFile, entryName, hint, itemFile) {
  const candidates = [listFile?.name, entryName, itemFile?.name, file.name].map(leaf).filter(Boolean);
  let name = candidates.find(n => !generic(n)) || candidates[0] || '';
  const mime = knownType(file.type) || knownType(itemFile?.type) || file.type;
  if (generic(name) && hint) {
    const type = knownType(mime) || nameType(name);
    // Use a single item-specific filename hint, never a page title or a different file's URL.
    if (ext(hint) && (!type || nameType(hint) === type || ext(hint) === ext(name))) name = hint;
  }
  return name === file.name && mime === file.type ? file : new File([file], name, { type:mime, lastModified:file.lastModified });
}

function transferHint(dt) {
  const get = key => read(() => dt.getData(key)) || '';
  const promised = get('application/x-moz-file-promise-dest-filename') || /^([^:]+):([^:]+):/.exec(get('DownloadURL'))?.[2];
  if (promised) return leaf(promised);
  const uris = get('text/uri-list').split(/\r?\n/).filter(line => line && !line.startsWith('#'));
  if (uris.length !== 1) return '';
  const url = read(() => new URL(uris[0]));
  return url && /^(file|https?):$/.test(url.protocol) ? leaf(read(() => decodeURIComponent(url.pathname.split('/').at(-1)))) : '';
}

export function transferredFiles(dt) {
  const listed = Array.from(dt?.files || []), paired = new Map(), extra = [];
  const slots = Array.from(dt?.items || []).filter(i => i.kind === 'file').map(i => ({
    file: read(() => i.getAsFile()), entry: read(() => i.webkitGetAsEntry?.()),
  }));
  const hint = Math.max(slots.length, listed.length) === 1 ? transferHint(dt) : '';
  for (const [i, {file, entry}] of slots.entries()) {
    let index = listed.findIndex((f, n) => !paired.has(n) && (f === file ||
      f.name === (entry?.name || file?.name) && (!file || f.size === file.size)));
    if (index < 0 && file && generic(file.name)) {
      const matches = listed.map((f,n) => !paired.has(n) && f.size === file.size &&
        (!knownType(f.type) || !knownType(file.type) || f.type === file.type) ? n : -1).filter(n => n >= 0);
      if (matches.length === 1 || matches.includes(i)) index = matches.includes(i) ? i : matches[0];
    }
    if (index < 0 && slots.length === listed.length && !paired.has(i)
        && (!file || !file.size || !listed[i].size || file.size === listed[i].size && generic(listed[i].name))) index = i;
    const listFile = listed[index];
    const bytes = listFile?.size ? listFile : file?.size ? file : listFile || file;
    let result = null;
    if (!entry?.isDirectory) {
      const named = f => f ? namedFile(f, listFile, entry?.name, hint, file) : null;
      // Some native apps promise a file: request its contents before the drag store expires.
      result = bytes?.size || !entry?.isFile ? named(bytes) : new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), 20000);
        const finish = f => { clearTimeout(timer); resolve(named(f)); };
        try { entry.file(finish, () => finish(null)); } catch { finish(null); }
      });
    }
    if (index < 0) extra.push(result); else paired.set(index,result);
  }
  const ordered = listed.map((f,i) => paired.has(i) ? paired.get(i) : namedFile(f, f, '', hint));
  return Promise.all([...ordered, ...extra]).then(all => all.filter(Boolean));
}

function sniff(bytes) {
  const s = String.fromCharCode(...bytes);
  if (s.startsWith('\x89PNG\r\n\x1a\n')) return types.png;
  if (s.startsWith('\xff\xd8\xff')) return types.jpg;
  if (/^GIF8[79]a/.test(s)) return types.gif;
  if (s.startsWith('%PDF-')) return types.pdf;
  if (s.startsWith('RIFF') && s.slice(8,12) === 'WAVE') return types.wav;
  if (s.startsWith('RIFF') && s.slice(8,12) === 'WEBP') return types.webp;
  if (s.startsWith('PK\x03\x04')) return types.zip;
  if (!s || /[\x00-\x08\x0e-\x1f\x7f]/.test(s)) return '';
  return read(() => new TextDecoder('utf-8', {fatal:true}).decode(bytes, {stream:true})) ? 'text/plain' : '';
}

export async function previewDescriptor(file) {
  let type = knownType(file.type) || nameType(file.name);
  if (!type) type = sniff(new Uint8Array(await file.slice(0, 512).arrayBuffer()));
  else if (type === types.pdf && !/^\s*%PDF-/.test(await file.slice(0, 128).text())) type = 'application/octet-stream';
  const kind = /^(image|audio|video)\//.exec(type)?.[1] || (type === types.pdf ? 'pdf' :
    /^(?:text\/|application\/(?:json|xml|javascript|[\w.-]+\+(?:json|xml))$)/.test(type) ? 'text' : 'file');
  const fallbackExt = Object.keys(types).find(key => types[key] === type);
  const name = leaf(file.name) || ({image:'Image',audio:'Audio',video:'Video',pdf:'Document',text:'Text',file:'Attachment'}[kind] +
    (fallbackExt ? '.' + fallbackExt : ''));
  // Do not navigate to a dropped HTML/SVG document. HTML is escaped text; SVG is used only as an image.
  const blobType = kind === 'text' ? 'text/plain' : kind === 'file' ? 'application/octet-stream' : type;
  return { name, type, kind, blob:file.slice(0, file.size, blobType) };
}
