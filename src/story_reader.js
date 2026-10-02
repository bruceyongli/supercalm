// Read one conversation window off the HTTP/event-loop thread. Tool results can be hundreds of MB;
// they must never stall launch options, input delivery or the live terminal while Story is parsing.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseSessionLog, completedRoundStarts } from './story.js';

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
      const user = j.type === 'user' || (j.type === 'event_msg' && j.payload?.type === 'user_message')
        || (j.type === 'response_item' && j.payload?.type === 'message' && j.payload?.role === 'user');
      if (user && (Date.parse(j.timestamp) || 0) === ts) return offset;
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
      if (!full && completed.length >= rounds) {
        const first = completed[completed.length - rounds];
        offset += roundOffset(text, events[first].ts || 0);
        events = events.slice(first);
        // Once we reached the beginning, metadata before the first request is not another round.
        if (start === 0 && completed.length <= rounds) offset = 0;
      }
      // Claude embeds screenshot payloads in tool results. Keep only the last four small images,
      // and only scan them on the reader thread (Codex tool text needs no second JSON parse).
      if (text.includes('"source":{"type":"base64"')) attachShots(text, events);
      return { events, meta: { count: events.length, trimmed: offset > 0, full: full || offset === 0,
        rounds, cursor: cursorFor(identity, offset), scannedBytes: end - start, totalBytes: st.size } };
    }
  } finally { await fh.close(); }
}

function attachShots(text, events) {
  const shots = [];
  const collect = (arr, ts, depth = 0) => {
    for (const item of arr || []) {
      if (item?.type === 'image' && item.source?.type === 'base64' && item.source.data?.length < 900_000) {
        shots.push({ ts, url: `data:${item.source.media_type || 'image/png'};base64,${item.source.data}` });
        if (shots.length > 4) shots.shift();
      } else if (depth < 2 && Array.isArray(item?.content)) collect(item.content, ts, depth + 1);
    }
  };
  for (const line of text.split('\n')) {
    if (!line.includes('"base64"')) continue;
    try {
      const j = JSON.parse(line), ts = Date.parse(j.timestamp) || 0;
      collect(j?.toolUseResult?.content, ts); collect(j?.message?.content, ts);
    } catch {}
  }
  for (const shot of shots) {
    const event = events.find(e => !e.shot && ['check', 'edit', 'work'].includes(e.kind) && Math.abs((e.ts || 0) - shot.ts) < 180e3);
    if (event) event.shot = shot.url;
  }
}

if (!isMainThread) parentPort.on('message', async ({ id, args }) => {
  try { parentPort.postMessage({ id, result: await readStoryWindow(args) }); }
  catch (error) { parentPort.postMessage({ id, error: error.message, code: error.code }); }
});
