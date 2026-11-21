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

function dropName(candidates, type, hint) {
  candidates = candidates.map(leaf).filter(Boolean);
  let name = candidates.find(n => !generic(n)) || candidates[0] || '';
  if (generic(name) && hint) {
    // Use a single item-specific filename hint, never a page title or a different file's URL.
    if (ext(hint) && (!type || nameType(hint) === type || ext(hint) === ext(name))) name = hint;
  }
  return name;
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

export const COMPOSER_FILE_LIMIT = 24 * 1024 * 1024;
const emptyMedia = (name, type) => [knownType(type),nameType(name)].some(t => /^(?:image\/|audio\/|video\/|application\/pdf$)/.test(t));
export const missingMediaBytes = file => file.size === 0 && emptyMedia(file.name, file.type);
const unreadable = () => Object.assign(new Error('The source app shared a filename, but the browser could not read the original file.'), {code:'source-unreadable'});
const tooLarge = limit => Object.assign(new Error('File exceeds the ' + Math.round(limit/1024/1024) + ' MB attachment limit.'), {code:'file-too-large'});

// Capture only representations of this dropped item. Never open a file:// path, call
// requestPermission, or substitute an unrelated clipboard thumbnail for the original.
function dropSource(listFile, slot = {}, hint) {
  const { file, entry, item } = slot;
  const direct = [...new Set([listFile, file].filter(Boolean))].sort((a,b) => Number(!a.size)-Number(!b.size));
  const type = direct.map(f => knownType(f.type)).find(Boolean) || knownType(item?.type);
  const names = [listFile?.name, entry?.name, file?.name];
  const name = dropName(names, type, hint), size = direct[0]?.size || 0;
  return {name, type, size, async read({signal, limit = COMPOSER_FILE_LIMIT} = {}) {
    if (signal?.aborted) throw signal.reason;
    if (direct.some(f => f.size > limit)) throw tooLarge(limit);
    // Both capabilities must be obtained INSIDE the drop event, even when FileList
    // already advertises a nonzero size. Bytes may still be unavailable from that File.
    const entryFile = () => entry?.isFile ? new Promise(resolve => {
      try { entry.file(resolve, () => resolve(null)); } catch { resolve(null); }
    }) : null;
    const entryFirst = entryFile();
    const handle = item?.getAsFileSystemHandle
      ? Promise.resolve(read(() => item.getAsFileSystemHandle())).catch(() => null) : null;
    let realHandle = false;
    const fromHandle = async () => {
      const h = await handle;
      if (h?.kind !== 'file') return null;
      realHandle = true;
      return h.getFile();
    };
    let oversized = false;
    const snapshot = async candidate => {
      const f = typeof candidate?.then === 'function' ? await candidate : candidate;
      if (!f || signal?.aborted) throw unreadable();
      if (f.size > limit) { oversized = true; throw tooLarge(limit); }
      // When a real file entry exists, a zero-size FileList placeholder is not proof
      // of an empty document. Use the fulfilled entry/handle for that case.
      if (!f.size && emptyMedia(name || f.name, type || f.type)) throw unreadable();
      const bytes = await f.arrayBuffer();
      if (bytes.byteLength !== f.size || signal?.aborted) throw unreadable();
      const mime = knownType(f.type) || type;
      // new File([f]) and f.slice() are lazy references to the source; copy actual
      // bytes once so preview and upload see the SAME original after the drag expires.
      return new File([bytes], dropName([...names,f.name], mime, hint), {type:mime,lastModified:f.lastModified});
    };
    const budget = (promise, ms) => new Promise((resolve,reject) => {
      const finish = (fn,v) => { clearTimeout(timer); signal?.removeEventListener('abort',abort); fn(v); };
      const abort = () => finish(reject,signal.reason);
      const timer = setTimeout(() => finish(reject,unreadable()),ms);
      signal?.addEventListener('abort',abort,{once:true});
      promise.then(v => finish(resolve,v),e => finish(reject,e));
      if (signal?.aborted) abort();
    });
    const attempts = [], deadline = Date.now() + 30000;
    for (const f of direct.filter(f => f.size || (!entryFirst && !handle))) {
      attempts.push(snapshot(f));
      // Start an alternate if a native export is slow, but keep the original read in the
      // race. A readable large/cloud file doesn't become an error just because 1.5s elapsed.
      try { return await budget(Promise.any(attempts),1500); } catch { if (signal?.aborted) throw signal.reason; }
    }
    if (entryFirst || handle) {
      const fresh = async (first, again) => {
        try { return await snapshot(first); } catch (err) {
          // One fresh snapshot if a native export changed after getFile. Do not retry a
          // permission denial or ask for new access; both paths refer only to this drop.
          if (signal?.aborted || !['NotFoundError','NotReadableError'].includes(err.name)) throw err;
          return snapshot(again());
        }
      };
      if (entryFirst) attempts.push(fresh(entryFirst,entryFile));
      if (handle) attempts.push(fresh(fromHandle(),fromHandle));
    }
    try { return await budget(Promise.any(attempts), Math.max(1,deadline-Date.now())); }
    catch { if (signal?.aborted) throw signal.reason; }
    if (oversized) throw tooLarge(limit);
    // A genuine empty non-media file is allowed when there is no contrary native
    // evidence. An empty JPEG/PDF/audio file must NEVER become a successful upload.
    if (!entryFirst && !realHandle && direct.some(f => !f.size) && !emptyMedia(name,type)) {
      try { return await snapshot(direct.find(f => !f.size)); } catch {}
    }
    throw unreadable();
  }};
}

export function captureTransferredFiles(dt) {
  const listed = Array.from(dt?.files || []), paired = new Map(), extra = [];
  const slots = Array.from(dt?.items || []).filter(i => i.kind === 'file').map(i => ({
    item:i, file: read(() => i.getAsFile()), entry: read(() => i.webkitGetAsEntry?.()),
  }));
  const hint = Math.max(slots.length, listed.length) === 1 ? transferHint(dt) : '';
  for (const [i, slot] of slots.entries()) {
    const {file,entry} = slot;
    let index = listed.findIndex((f, n) => !paired.has(n) && (f === file ||
      f.name === (entry?.name || file?.name) && (!file || f.size === file.size)));
    if (index < 0 && file && generic(file.name)) {
      const matches = listed.map((f,n) => !paired.has(n) && f.size === file.size &&
        (!knownType(f.type) || !knownType(file.type) || f.type === file.type) ? n : -1).filter(n => n >= 0);
      if (matches.length === 1 || matches.includes(i)) index = matches.includes(i) ? i : matches[0];
    }
    if (index < 0 && slots.length === listed.length && !paired.has(i)
        && (!file || !file.size || !listed[i].size || file.size === listed[i].size && generic(listed[i].name))) index = i;
    const result = entry?.isDirectory ? null : dropSource(listed[index],slot,hint);
    if (index < 0) extra.push(result); else paired.set(index,result);
  }
  return [...listed.map((f,i) => paired.has(i) ? paired.get(i) : dropSource(f,{},hint)), ...extra].filter(Boolean);
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
