// Read one conversation window off the HTTP/event-loop thread. Tool results can be hundreds of MB;
// they must never stall launch options, input delivery or the live terminal while Story is parsing.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { openReaderFile } from './reader_file.js';
import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';
import { parseSessionLog, createSessionLogParser, completedRoundStarts } from './story.js';
import { claudeQueuedUser } from './claude_lifecycle.js';

const START_BYTES = 256 * 1024;
const MAX_BYTES = 32 * 1024 * 1024;
// Only byte-offset hints, never retained raw history. A growing native transcript can start at the
// previous window instead of repeatedly reading/parsing 256K, 512K, 1M ... across the network.
const windowHints = new Map();
const pool = [];
const queue = [];
const flights = new Map();
let serial = 0;

// Parsed native state only: no raw tool-output windows, base64 images or local transcript copies.
// Each of the two sticky workers owns at most 8 MiB of serialized state (16 MiB total).
const liveWindows = new Map();
let liveBytes = 0;
const LIVE_BUDGET = 8 * 1024 * 1024;
function takeWindow(key) {
  const entry = liveWindows.get(key);
  if (entry) { liveWindows.delete(key); liveBytes -= entry.weight; }
  return entry;
}
function keepWindow(key, entry) {
  if (!entry.cacheable) return;
  entry.weight = serialize({ state: entry.parser.snapshot(), offsets: entry.offsets,
    shots: entry.shots, anchors: entry.anchors }).byteLength;
  if (entry.weight > LIVE_BUDGET) return;
  takeWindow(key);
  liveWindows.set(key, entry); liveBytes += entry.weight;
  while (liveBytes > LIVE_BUDGET || liveWindows.size > 32) takeWindow(liveWindows.keys().next().value);
}

function parseAppend(entry, buffer, position) {
  let start = 0, parsed = 0;
  entry.cacheable = true;
  while (start < buffer.length) {
    const newline = buffer.indexOf(10, start), end = newline < 0 ? buffer.length : newline;
    const line = buffer.subarray(start, end).toString('utf8');
    let record;
    try { record = JSON.parse(line); } catch {}
    if (record && typeof record === 'object') {
      entry.parser.append(record); parsed++;
      const queued = claudeQueuedUser(record);
      if (queued || record.type === 'user' || (record.type === 'event_msg' && record.payload?.type === 'user_message')
          || (record.type === 'response_item' && record.payload?.type === 'message' && record.payload?.role === 'user')) {
        const ts = Date.parse(queued?.timestamp || record.timestamp) || 0;
        if (!entry.offsets.has(ts)) entry.offsets.set(ts, position + start);
      }
      if (line.includes('"base64"') && end - start <= MAX_IMAGE_RECORD_BYTES) {
        for (const [index] of recordImages(record).entries()) {
          const ref = Buffer.from(JSON.stringify({ identity: entry.identity, offset: position + start,
            length: end - start, index, hash: recordHash(line) })).toString('base64url');
          entry.shots.push({ ts: Date.parse(record.timestamp) || 0, ref });
          if (entry.shots.length > 4) entry.shots.shift();
        }
      }
      // A complete JSON record without its newline is visible, but not a safe append checkpoint.
      if (newline < 0) entry.cacheable = false;
    }
    if (newline < 0) break;
    start = newline + 1; entry.committed = position + start;
  }
  return parsed;
}

function windowResult(entry, end, rounds, ioBytes, parsedRecords, mode) {
  let events = entry.parser.events(), offset = entry.start;
  const completed = completedRoundStarts(events);
  if (completed.length >= rounds) {
    const first = completed[completed.length - rounds];
    offset = entry.offsets.get(events[first].ts || 0) ?? offset;
    events = events.slice(first);
    if (entry.start === 0 && completed.length <= rounds) offset = 0;
  }
  for (const shot of entry.shots) {
    const event = events.find(e => !e.shotRef && ['check', 'edit', 'work'].includes(e.kind) && Math.abs((e.ts || 0) - shot.ts) < 180e3);
    if (event) event.shotRef = shot.ref;
  }
  return { events, meta: { count: events.length, trimmed: offset > 0, full: offset === 0,
    rounds, cursor: cursorFor(entry.identity, offset), scannedBytes: end - entry.start, ioBytes,
    totalBytes: end, parsedRecords, readMode: mode } };
}

function rememberAnchors(entry, buffer, position, st) {
  const length = Math.min(4096, entry.committed - position);
  if (length > 0) {
    const tail = { position: entry.committed - length,
      data: Buffer.from(buffer.subarray(entry.committed - length - position, entry.committed - position)) };
    entry.anchors = [entry.anchors?.[0] || { position, data: Buffer.from(buffer.subarray(0, length)) }, tail];
  }
  Object.assign(entry, { size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs });
}

async function advanceWindow(fh, entry, st, identity, rounds) {
  if (entry.identity !== identity || st.size < entry.size || st.mtimeMs < entry.mtime) return null;
  if (st.size === entry.size) {
    return st.mtimeMs === entry.mtime && st.ctimeMs === entry.ctime
      ? windowResult(entry, st.size, rounds, 0, 0, 'unchanged') : null;
  }
  if (!entry.anchors?.length || st.size - entry.committed > MAX_BYTES) return null;
  let ioBytes = 0;
  // Native histories are append-only. Rotation/truncation/same-size rewrites invalidate state;
  // prefix and committed-tail anchors also reject replaced content before an apparent append.
  // Read the tail guard and appended bytes together; overlap the independent prefix guard.
  // Three serial tiny reads on an under-pressure network mount can cost seconds EACH.
  const readAt = async (position, length) => {
    const bytes = Buffer.alloc(length);
    for (let offset = 0; offset < length;) {
      const { bytesRead } = await fh.read(bytes, offset, length - offset, position + offset);
      if (!bytesRead) throw Object.assign(new Error('Story changed while reading. Please retry.'), { code: 'STORY_CHANGED' });
      offset += bytesRead; ioBytes += bytesRead;
    }
    return bytes;
  };
  const [prefix, tail] = entry.anchors, start = entry.committed;
  const combinedStart = Math.min(start, tail.position);
  const prefixOutside = prefix.position < combinedStart;
  const [combined, separatePrefix] = await Promise.all([
    readAt(combinedStart, st.size - combinedStart),
    prefixOutside ? readAt(prefix.position, prefix.data.length) : null,
  ]);
  for (const anchor of entry.anchors) {
    const bytes = anchor === prefix && prefixOutside ? separatePrefix
      : combined.subarray(anchor.position - combinedStart, anchor.position - combinedStart + anchor.data.length);
    if (!bytes.equals(anchor.data)) return null;
  }
  const buffer = combined.subarray(start - combinedStart);
  const parsed = parseAppend(entry, buffer, start);
  rememberAnchors(entry, buffer, start, st);
  return windowResult(entry, st.size, rounds, ioBytes, parsed, 'incremental');
}

function dispatch() {
  for (const slot of pool) {
    if (slot.job || !queue.length) continue;
    const index = queue.findIndex(job => job.workerIndex === slot.index);
    if (index < 0) continue;
    const job = slot.job = queue.splice(index, 1)[0];
    slot.worker.ref();
    slot.timer = setTimeout(() => slot.worker.terminate(), 60_000);
    slot.worker.postMessage({ id: job.id, args: job.args });
  }
}

export function readStoryPage(args) {
  return runReader(args);
}

export function readStoryImage({ file, ref }) {
  return runReader({ file, ref, image: true });
}

function runReader(args) {
  // One read per exact page/image. Appends while a read is pending are caught by the next
  // invalidation, not an unbounded line of obsolete reads from several devices/SSE refreshes.
  const key = JSON.stringify([args.file, args.sourceIdentity || null, args.rounds || 1, !!args.full, args.cursor || null, args.ref || null, !!args.image]);
  if (flights.has(key)) return flights.get(key);
  const flight = new Promise((resolve, reject) => {
    if (queue.length >= 64) return reject(new Error('Story reader is busy; please retry.'));
    while (pool.length < 2) {
      const worker = new Worker(new URL(import.meta.url), { execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')) });
      const slot = { worker, job: null, timer: null, index: pool.some(s => s.index === 0) ? 1 : 0 };
      pool.push(slot);
      worker.on('message', (message) => {
        const job = slot.job;
        if (!job || message.id !== job.id) return;
        clearTimeout(slot.timer);
        slot.job = null;
        worker.unref();
        if (message.error) job.reject(Object.assign(new Error(message.error), { code: message.code }));
        else job.resolve(message.result);
        dispatch();
      });
      let failed = false;
      const fail = (error) => {
        if (failed) return;
        failed = true;
        clearTimeout(slot.timer);
        slot.job?.reject(error);
        slot.job = null;
        const index = pool.indexOf(slot);
        if (index >= 0) pool.splice(index, 1);
        // Queued callers can retry; a crashed reader must not leave their promises hanging forever.
        for (const job of queue.splice(0)) job.reject(error);
      };
      worker.once('error', fail);
      worker.once('exit', () => fail(new Error('Story reader stopped. Please retry.')));
      worker.unref();
    }
    // Stable ownership keeps each transcript's parser on one worker across live refreshes.
    const workerIndex = createHash('sha256').update(args.file).digest()[0] % 2;
    queue.push({ id: ++serial, args, resolve, reject, workerIndex });
    dispatch();
  }).finally(() => { if (flights.get(key) === flight) flights.delete(key); });
  flights.set(key, flight);
  return flight;
}

// Cursor binds a byte boundary to this exact transcript/inode, not a timestamp or an expanding
// "last N rounds" window. Append-only growth leaves earlier pages stable; rotation invalidates it.
function fingerprint(file, st) {
  return createHash('sha256').update(`${file}|${st.dev}|${st.ino}`).digest('hex').slice(0, 24);
}
function decodeCursor(cursor, identity, size) {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (value.identity === identity && Number.isSafeInteger(value.offset) && value.offset >= 0 && value.offset <= size) return value.offset;
  } catch {}
  throw Object.assign(new Error('History changed. Reload the recent conversation.'), { code: 'STORY_CURSOR_INVALID' });
}
function cursorFor(identity, offset) {
  return offset > 0 ? Buffer.from(JSON.stringify({ identity, offset })).toString('base64url') : null;
}

// Locate the raw user record corresponding to the normalized round boundary. Keep Codex's mirrored
// event/response records together; never split one request into separate pagination pages.
function roundOffset(text, ts) {
  let offset = 0;
  for (const line of text.split('\n')) {
    try {
      const j = JSON.parse(line);
      const queued = claudeQueuedUser(j);
      const user = queued || j.type === 'user' || (j.type === 'event_msg' && j.payload?.type === 'user_message')
        || (j.type === 'response_item' && j.payload?.type === 'message' && j.payload?.role === 'user');
      if (user && (Date.parse(queued?.timestamp || j.timestamp) || 0) === ts) return offset;
    } catch {}
    offset += Buffer.byteLength(line) + 1;
  }
  return 0;
}

export async function readStoryWindow({ file, rounds = 1, full = false, cursor = null }) {
  const fh = await openReaderFile(file);
  try {
    const st = await fh.stat();
    const identity = fingerprint(file, st);
    const liveKey = !full && !cursor ? `${file}|${rounds}` : null;
    const previous = liveKey && takeWindow(liveKey);
    if (previous) {
      const result = await advanceWindow(fh, previous, st, identity, rounds);
      if (result) { keepWindow(liveKey, previous); return result; }
    }
    const end = cursor ? decodeCursor(cursor, identity, st.size) : st.size;
    const hintKey = `${identity}|${rounds}|${cursor || ''}`;
    const hint = windowHints.get(hintKey);
    const hintedBytes = hint && st.size >= hint.size ? Math.min(MAX_BYTES, end - hint.start) : 0;
    // Probe the small tail first: a new short round must not inherit the previous huge tool window.
    let bytes = full ? end : Math.min(START_BYTES, end);
    let retained = Buffer.alloc(0), retainedStart = end, ioBytes = 0;
    for (;;) {
      let start = Math.max(0, end - bytes);
      const rangeStart = start;
      // Expand backwards by reading ONLY the missing prefix. Short network reads are not EOF.
      const prefix = Buffer.alloc(retainedStart - start);
      for (let offset = 0; offset < prefix.length;) {
        const { bytesRead } = await fh.read(prefix, offset, prefix.length - offset, start + offset);
        if (!bytesRead) throw Object.assign(new Error('Story changed while reading. Please retry.'), { code: 'STORY_CHANGED' });
        offset += bytesRead; ioBytes += bytesRead;
      }
      const buffer = retained.length ? Buffer.concat([prefix, retained]) : prefix;
      retained = buffer; retainedStart = start;
      let text = buffer.toString('utf8');
      if (start > 0) {
        const newline = buffer.indexOf(10);
        if (newline >= 0) { start += newline + 1; text = buffer.subarray(newline + 1).toString('utf8'); }
        else text = ''; // a partial giant tool-result line is not a conversation boundary
      }
      let entry, parsed = 0;
      if (liveKey && text) {
        entry = { parser: createSessionLogParser(), offsets: new Map(), shots: [], identity,
          start, committed: start, cacheable: true };
        parsed = parseAppend(entry, buffer.subarray(start - rangeStart), start);
      }
      let events = entry ? entry.parser.events() : parseSessionLog(text);
      const completed = completedRoundStarts(events);
      if (!full && completed.length < rounds && start > 0 && bytes < MAX_BYTES) {
        bytes = Math.min(MAX_BYTES, Math.max(bytes * 2, hintedBytes));
        continue;
      }
      if (entry) {
        const window = buffer.subarray(start - rangeStart);
        rememberAnchors(entry, window, start, st);
        keepWindow(liveKey, entry);
        const result = windowResult(entry, end, rounds, ioBytes, parsed, 'tail');
        windowHints.delete(hintKey); windowHints.set(hintKey, { start: rangeStart, size: st.size });
        while (windowHints.size > 120) windowHints.delete(windowHints.keys().next().value);
        return result;
      }
      let offset = start;
      // A single tool-result line can exceed the scan budget. If skipping its partial prefix reaches
      // the page end, still advance the cursor backward rather than offering the same empty page forever.
      if (offset >= end && rangeStart < end) offset = rangeStart;
      if (!full && completed.length >= rounds) {
        const first = completed[completed.length - rounds];
        offset += roundOffset(text, events[first].ts || 0);
        events = events.slice(first);
        // Once we reached the beginning, metadata before the first request is not another round.
        if (start === 0 && completed.length <= rounds) offset = 0;
      }
      // Screenshot bytes must not travel inside the report JSON: four screenshots can outweigh
      // the entire conversation and prevent the mobile cache from saving even its final report.
      if (text.includes('"base64"')) attachShots(text, events, { start, identity });
      if (!full) {
        windowHints.delete(hintKey);
        windowHints.set(hintKey, { start: rangeStart, size: st.size });
        while (windowHints.size > 120) windowHints.delete(windowHints.keys().next().value);
      }
      return { events, meta: { count: events.length, trimmed: offset > 0, full: full || offset === 0,
        rounds, cursor: cursorFor(identity, offset), scannedBytes: end - start, ioBytes, totalBytes: st.size } };
    }
  } finally { await fh.close(); }
}

const MAX_IMAGE_RECORD_BYTES = 8 * 1024 * 1024;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
function recordImages(j) {
  const images = [];
  const collect = (arr, depth = 0) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr || []) {
      if (item?.type === 'image' && item.source?.type === 'base64'
          && typeof item.source.data === 'string' && item.source.data.length < 900_000
          && IMAGE_MIMES.has(item.source.media_type || 'image/png')) {
        images.push({ mime: item.source.media_type || 'image/png', data: item.source.data });
      } else if (depth < 2 && Array.isArray(item?.content)) collect(item.content, depth + 1);
    }
  };
  collect(j?.toolUseResult?.content); collect(j?.message?.content);
  return images;
}
const recordHash = line => createHash('sha256').update(line).digest('hex');
function attachShots(text, events, { start, identity }) {
  const shots = [];
  let offset = start;
  for (const line of text.split('\n')) {
    const length = Buffer.byteLength(line), position = offset;
    offset += length + 1;
    if (!line.includes('"base64"') || length > MAX_IMAGE_RECORD_BYTES) continue;
    try {
      const j = JSON.parse(line), ts = Date.parse(j.timestamp) || 0;
      const images = recordImages(j);
      if (!images.length) continue;
      const hash = recordHash(line);
      for (let index = 0; index < images.length; index++) {
        const ref = Buffer.from(JSON.stringify({ identity, offset: position, length, index, hash })).toString('base64url');
        shots.push({ ts, ref });
        if (shots.length > 4) shots.shift();
      }
    } catch {}
  }
  for (const shot of shots) {
    const event = events.find(e => !e.shotRef && ['check', 'edit', 'work'].includes(e.kind) && Math.abs((e.ts || 0) - shot.ts) < 180e3);
    if (event) event.shotRef = shot.ref;
  }
}

// The HTTP caller supplies ONLY the session's resolved transcript. A reference cannot choose a
// filesystem path, cross into a sibling session, survive rotation, or read arbitrary tool text.
export async function readStoryImageRecord({ file, ref }) {
  const missing = () => Object.assign(new Error('Story image is no longer available.'), { code: 'STORY_IMAGE_MISSING' });
  let value;
  try { if (typeof ref !== 'string' || ref.length > 1024) throw missing(); value = JSON.parse(Buffer.from(ref, 'base64url')); }
  catch { throw missing(); }
  const fh = await openReaderFile(file);
  try {
    const st = await fh.stat();
    const { offset, length, index, hash } = value || {};
    if (value?.identity !== fingerprint(file, st) || !Number.isSafeInteger(offset) || offset < 0
        || !Number.isSafeInteger(length) || length <= 0 || length > MAX_IMAGE_RECORD_BYTES || offset + length > st.size
        || !Number.isSafeInteger(index) || index < 0 || !/^[a-f0-9]{64}$/.test(hash)) throw missing();
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buffer, 0, length, offset);
    if (bytesRead !== length || recordHash(buffer) !== hash) throw missing();
    let image;
    try { image = recordImages(JSON.parse(buffer))[index]; } catch { throw missing(); }
    if (!image) throw missing();
    return { mime: image.mime, data: Buffer.from(image.data, 'base64') };
  } finally { await fh.close(); }
}

if (!isMainThread) parentPort.on('message', async ({ id, args }) => {
  try { parentPort.postMessage({ id, result: await (args.image ? readStoryImageRecord(args) : readStoryWindow(args)) }); }
  catch (error) { parentPort.postMessage({ id, error: error.message, code: error.code }); }
});
