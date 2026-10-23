#!/usr/bin/env node
// Local operator migration controller; touches only AIOS's own terminal log taps.
// Coding agents keep running. The brief final merge is performed with AIOS down so
// its pipe-repair loop cannot bypass an unfinished spool.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile, realpath, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH, LOG_DIR, TMUX } from '../src/config.js';
import { liveStorageConfig, assertLiveStorage } from '../src/live_storage.js';
import { durableJson, openFiles } from '../src/storage_migration.js';
import { mergeStorageLog } from '../src/storage_log_handoff.js';
import { shquote } from '../src/util.js';
const exec = promisify(execFile);
const [operation, entryFile] = process.argv.slice(2);
const config = liveStorageConfig();
const mapping = config?.mappings.find(m => m.source === LOG_DIR);
if (!mapping) throw Error('Terminal log root is not approved for migration');
const control = join(dirname(config.journalRoot), 'terminal-log-handoff');
const journalFile = join(control, 'job.json');
await mkdir(control, { recursive: true, mode: 0o700 });
let job;
try { job = JSON.parse(await readFile(journalFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (operation === 'merge') {
  if (!entryFile?.startsWith(control + '/') || !entryFile.endsWith('.json') || entryFile.includes('/../')) throw Error('Invalid spool journal');
  await assertLiveStorage(LOG_DIR, config);
  const entry = JSON.parse(await readFile(entryFile, 'utf8'));
  if (!job?.entries.some(e => e.file === entryFile) || entry.target !== join(mapping.target, entry.id + '.log')) throw Error('Spool does not belong to this migration');
  // Replacement of pipe-pane closes the old writer, but allow its final buffered
  // write to drain before opening the spool as immutable input.
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!(await openFiles([entry.spool])).length) break;
    if (attempt === 39) throw Error('Previous spool writer has not closed');
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(JSON.stringify(await mergeStorageLog(entryFile)));
} else if (operation === 'start') {
  if (job) throw Error('An existing log handoff must be finished first');
  if (mapping.active) throw Error('The log root is already remote');
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const sessions = db.prepare('select id,tmux from sessions').all(); db.close();
  const panes = (await exec(TMUX, ['list-panes', '-a', '-F', '#{session_name}|#{pane_id}|#{pane_pipe}'])).stdout.trim().split('\n').map(l => l.split('|'));
  const handles = await openFiles([LOG_DIR]);
  job = { version: 1, kind: 'storage-log-handoff', phase: 'starting', id: randomUUID(), entries: [], createdAt: Date.now() };
  for (const s of sessions) {
    const pane = panes.find(p => p[0] === s.tmux);
    if (!pane || pane[2] !== '1') continue;
    const path = join(LOG_DIR, s.id + '.log');
    if (!handles.some(h => h.path === path && h.command === 'cat' && h.descriptor === '1')) throw Error('Terminal tap ownership is not proven: ' + s.id);
    const spool = join(control, s.id + '.spool'), file = join(control, s.id + '.json');
    await writeFile(spool, '', { flag: 'wx', mode: 0o600 });
    const entry = { version: 1, kind: job.kind, id: s.id, pane: pane[1], spool, target: join(mapping.target, s.id + '.log'), phase: 'prepared' };
    await durableJson(file, entry); job.entries.push({ id: s.id, pane: pane[1], file, spool });
  }
  await durableJson(journalFile, job);
  for (const e of job.entries) await exec(TMUX, ['pipe-pane', '-t', e.pane, `exec cat >> ${shquote(e.spool)}`]);
  job.phase = 'spooling'; await durableJson(journalFile, job);
  console.log(JSON.stringify({ spooling: job.entries.length, journal: journalFile, agentsRestarted: 0 }));
} else if (operation === 'finish') {
  if (!job || !['spooling', 'merging'].includes(job.phase)) throw Error('No active log handoff');
  await assertLiveStorage(LOG_DIR, config);
  if (await realpath(LOG_DIR) !== mapping.target) throw Error('Terminal root cutover is not complete');
  // The operator must stop only the API service, NOT the tmux server/agents.
  const live = await fetch('http://127.0.0.1:8793/healthz', { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
  if (live) throw Error('Pause the API service before the final ordered spool handoff');
  job.phase = 'merging'; await durableJson(journalFile, job);
  for (const e of job.entries) {
    const entry = JSON.parse(await readFile(e.file, 'utf8'));
    if (entry.phase === 'merged') continue;
    const present = await exec(TMUX, ['display-message', '-p', '-t', e.pane, '#{pane_id}']).then(r => r.stdout.trim() === e.pane, () => false);
    if (!present) {
      if ((await openFiles([e.spool])).length) throw Error('Retired terminal still has a spool writer');
      await mergeStorageLog(e.file);
      continue;
    }
    const command = `${shquote(process.execPath)} ${shquote(fileURLToPath(import.meta.url))} merge ${shquote(e.file)} > ${shquote(e.file + '.receipt')} 2>&1 && exec cat >> ${shquote(entry.target)}`;
    await exec(TMUX, ['pipe-pane', '-t', e.pane, command]);
  }
  console.log(JSON.stringify({ merging: job.entries.length, journal: journalFile, verifyReceiptsBeforeRestart: true }));
} else if (operation === 'complete') {
  if (job?.phase !== 'merging') throw Error('No log merge is ready to complete');
  for (const e of job.entries) {
    const entry = JSON.parse(await readFile(e.file, 'utf8'));
    if (entry.phase !== 'merged') throw Error('A terminal spool is not merged: ' + e.id);
    await mergeStorageLog(e.file); // verify the exact range again; never append twice
  }
  job.phase = 'complete'; job.completedAt = Date.now(); await durableJson(journalFile, job);
  console.log(JSON.stringify({ complete: true, terminalStreams: job.entries.length, spoolsRetainedForAudit: true }));
} else if (operation === 'status') {
  console.log(JSON.stringify(job ? { phase: job.phase, entries: await Promise.all(job.entries.map(async e => {
    const entry = JSON.parse(await readFile(e.file, 'utf8'));
    return { id: e.id, phase: entry.phase, bytes: (await stat(e.spool)).size, digest: entry.digest || null };
  })) } : { phase: 'not-started' }));
} else throw Error('Usage: storage-log-handoff.mjs start|finish|complete|status');
