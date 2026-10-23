import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'aios-log-tty-'));
const socket = `aios-log-fixture-${process.pid}`;
const old = join(root, 'old'), spool = join(root, 'spool'), target = join(root, 'target');
const cli = join(root, 'cli.mjs'), merger = join(root, 'merge.mjs'), journal = join(root, 'journal.json');
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const mux = (...args) => exec('tmux', ['-L', socket, '-f', '/dev/null', ...args]);
const pause = ms => new Promise(r => setTimeout(r, ms));
try {
  await writeFile(old, ''); await writeFile(spool, '');
  await writeFile(cli, `process.stdin.setRawMode(true);process.stdin.resume();process.stdin.once('data',()=>{let n=0;const t=setInterval(()=>{process.stdout.write('FRAME:'+String(++n).padStart(4,'0')+'\\n');if(n===200)clearInterval(t)},10)});`);
  await writeFile(merger, `process.env.AIOS_DATA=${JSON.stringify(root)};const{mergeStorageLog}=await import(${JSON.stringify(resolve('src/storage_log_handoff.js'))});await new Promise(r=>setTimeout(r,100));await mergeStorageLog(process.argv[2]);`);
  await mux('new-session', '-d', '-s', 'fixture', `${quote(process.execPath)} ${quote(cli)}`);
  await mux('pipe-pane', '-t', 'fixture', `exec cat >> ${quote(old)}`);
  await pause(200); await mux('send-keys', '-t', 'fixture', '-l', 'start');
  await pause(300);
  await mux('pipe-pane', '-t', 'fixture', `exec cat >> ${quote(spool)}`);
  await pause(200); await copyFile(old, target);
  await writeFile(journal, JSON.stringify({ version: 1, kind: 'storage-log-handoff', phase: 'prepared', spool, target }));
  await mux('pipe-pane', '-t', 'fixture', `${quote(process.execPath)} ${quote(merger)} ${quote(journal)} && exec cat >> ${quote(target)}`);
  await pause(2500);
  const values = [...(await readFile(target, 'utf8')).matchAll(/FRAME:(\d+)/g)].map(m => Number(m[1]));
  assert.deepEqual(values, Array.from({ length: 200 }, (_, i) => i + 1), 'real terminal bytes stay ordered, with no loss or duplication');
  assert.equal(JSON.parse(await readFile(journal)).phase, 'merged');
  console.log('storage log TTY: 200 real streamed frames survived both pipe switches, exact order, zero missing/duplicate output');
} finally {
  await mux('kill-server').catch(() => {}); await rm(root, { recursive: true, force: true });
}
