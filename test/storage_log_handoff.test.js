import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = await mkdtemp(join(tmpdir(), 'aios-log-handoff-'));
process.env.AIOS_DATA = join(root, 'data');
const { mergeStorageLog } = await import('../src/storage_log_handoff.js');
try {
  await mkdir(process.env.AIOS_DATA);
  const source = join(root, 'spool'), target = join(root, 'log'), journal = join(root, 'entry.json');
  const job = { version: 1, kind: 'storage-log-handoff', spool: source, target, phase: 'prepared' };
  await writeFile(source, 'new output\n中文\n'); await writeFile(target, 'old output\n');
  await writeFile(journal, JSON.stringify(job));
  const first = await mergeStorageLog(journal);
  assert.equal(first.bytes, Buffer.byteLength('new output\n中文\n'));
  assert.equal(await readFile(target, 'utf8'), 'old output\nnew output\n中文\n');
  await appendFile(target, 'after handoff\n');
  await mergeStorageLog(journal);
  assert.equal(await readFile(target, 'utf8'), 'old output\nnew output\n中文\n' + 'after handoff\n', 'retry cannot duplicate the spool or disturb later output');
  // Simulate a crash after a partially persisted append and before the completion record.
  const saved = JSON.parse(await readFile(journal)); saved.phase = 'merging';
  await writeFile(journal, JSON.stringify(saved));
  await writeFile(target, 'old output\nnew ou');
  const recovered = await mergeStorageLog(journal);
  assert.equal(recovered.recoveredPrefix, 6);
  assert.equal(await readFile(target, 'utf8'), 'old output\nnew output\n中文\n');
  saved.phase = 'merging'; await writeFile(journal, JSON.stringify(saved));
  await writeFile(target, 'old output\nWRONG');
  await assert.rejects(mergeStorageLog(journal), /prefix differs/);
  assert.equal(await readFile(target, 'utf8'), 'old output\nWRONG', 'conflicts never truncate or overwrite');
  await appendFile(source, 'writer was not closed');
  await assert.rejects(mergeStorageLog(journal), /spool changed/);
  await rm(target);
  await assert.rejects(mergeStorageLog(journal), /ENOENT/);
  await assert.rejects(readFile(target), /ENOENT/, 'missing remote destination must not become a local file');
  console.log('storage log handoff: ordered output, idempotent retry, partial recovery, conflict retention, no offline fallback');
} finally { await rm(root, { recursive: true, force: true }); }
