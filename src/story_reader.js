// Read one conversation window off the HTTP/event-loop thread. Tool results can be hundreds of MB;
// they must never stall launch options, input delivery or the live terminal while Story is parsing.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseSessionLog, completedRoundStarts } from './story.js';
import { claudeQueuedUser } from './claude_lifecycle.js';

const START_BYTES = 256 * 1024;
const MAX_BYTES = 32 * 1024 * 1024;
const pool = [];
const queue = [];
let serial = 0;

function dispatch() {
  for (const slot of pool) {
    if (slot.job || !queue.length) continue;
    const job = slot.job = queue.shift();
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
  return new Promise((resolve, reject) => {
    if (queue.length >= 64) return reject(new Error('Story reader is busy; please retry.'));
    if (pool.length < 2) {
      const worker = new Worker(new URL(import.meta.url), { execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')) });
      const slot = { worker, job: null, timer: null };
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
      const fail = (error) => {
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
    queue.push({ id: ++serial, args, resolve, reject });
    dispatch();
  });
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
  const fh = await open(file, 'r');
  try {
    const st = await fh.stat();
    const identity = fingerprint(file, st);
    const end = cursor ? decodeCursor(cursor, identity, st.size) : st.size;
    let bytes = full ? end : Math.min(START_BYTES, end);
    for (;;) {
      let start = Math.max(0, end - bytes);
      const rangeStart = start;
      const buffer = Buffer.alloc(end - start);
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (start > 0) {
        const newline = buffer.indexOf(10);
        if (newline >= 0) { start += newline + 1; text = buffer.subarray(newline + 1, bytesRead).toString('utf8'); }
        else text = ''; // a partial giant tool-result line is not a conversation boundary
      }
      let events = parseSessionLog(text);
      const completed = completedRoundStarts(events);
      if (!full && completed.length < rounds && start > 0 && bytes < MAX_BYTES) {
        bytes = Math.min(MAX_BYTES, bytes * 2);
        continue;
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
      return { events, meta: { count: events.length, trimmed: offset > 0, full: full || offset === 0,
        rounds, cursor: cursorFor(identity, offset), scannedBytes: end - start, totalBytes: st.size } };
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
  const fh = await open(file, 'r');
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
