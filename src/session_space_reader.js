// Bounded graph I/O and parsing, isolated from the HTTP service's event loop.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { open } from 'node:fs/promises';
import { buildSpace } from './session_space_parser.js';

let worker = null, active = null, timer = null, serial = 0;
const queue = [];
function dispatch() {
  if (active || !queue.length) return;
  if (!worker) {
    const current = worker = new Worker(new URL(import.meta.url), {
      execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')),
    });
    current.on('message', message => {
      if (!active || message.id !== active.id) return;
      const job = active;
      active = null;
      clearTimeout(timer);
      current.unref();
      if (message.error) job.reject(new Error(message.error));
      else job.resolve(message.result);
      dispatch();
    });
    const fail = error => {
      if (worker !== current) return;
      worker = null;
      clearTimeout(timer);
      active?.reject(error);
      active = null;
      for (const job of queue.splice(0)) job.reject(error);
    };
    current.once('error', fail);
    current.once('exit', () => fail(new Error('Graph reader stopped. Please retry.')));
  }
  active = queue.shift();
  worker.ref();
  const current = worker;
  timer = setTimeout(() => current.terminate(), 60_000);
  current.postMessage({ id: active.id, args: active.args });
}
export function readSpace(args) {
  return new Promise((resolve, reject) => {
    if (queue.length >= 64) return reject(new Error('Graph reader is busy. Please retry.'));
    queue.push({ id: ++serial, args, resolve, reject });
    dispatch();
  });
}

export async function readTranscriptRange(file, start = 0, maxBytes = 4096) {
  const fh = await open(file, 'r');
  try {
    const st = await fh.stat();
    const length = Math.max(0, Math.min(st.size - start, maxBytes));
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

export async function readSpaceWindow({ file, session, maxBytes = 32 * 1024 * 1024 }) {
  const fh = await open(file, 'r');
  try {
    const st = await fh.stat();
    let offset = Math.max(0, st.size - maxBytes);
    const buffer = Buffer.alloc(st.size - offset);
    const { bytesRead } = await fh.read(buffer, 0, buffer.length, offset);
    let data = buffer.subarray(0, bytesRead);
    // Don't parse a partial JSON record at the start of a tail window.
    if (offset > 0) {
      const newline = data.indexOf(10);
      if (newline < 0) return { space: null, mtime: st.mtimeMs, offset, bytesRead };
      offset += newline + 1;
      data = data.subarray(newline + 1);
    }
    const space = buildSpace(data.toString('utf8'), session, offset);
    return { space, mtime: st.mtimeMs, offset, bytesRead };
  } finally { await fh.close(); }
}

if (!isMainThread) parentPort.on('message', async ({ id, args }) => {
  try { parentPort.postMessage({ id, result: await readSpaceWindow(args) }); }
  catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
