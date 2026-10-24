import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { runStorageCopyCommand } from '../src/storage_copy_command.js';
import { runStorageCopyPass } from '../src/storage_copy_baseline.js';

// Never inherit the agent's live session-storage TMPDIR or invoke a migration CLI.
const root = await mkdtemp('/tmp/aios-storage-copy-command-');
const receipt = { startedAt: 1000, completedAt: 2000, exitCode: 0, quiesced: false,
  result: { files: 4, copiedBytes: 12, unstableSources: [] } };
let fixtureId = 0;
const streams = [];
function fixture({ log, failSave } = {}) {
  const name = String(++fixtureId), file = join(root, name + '.json');
  const journal = { state: 'copied', createdAt: 500, copyBaselineAt: 1000,
    copiedAt: 2000, copyReceipt: structuredClone(receipt) };
  const snapshots = [];
  log ||= createWriteStream(join(root, name + '.log'));
  log.on('error', () => {}); streams.push(log);
  const save = async change => {
    if (failSave?.(change)) throw Object.assign(Error('private failure detail'), { code: 'ENOSPC' });
    snapshots.push(structuredClone(change));
    Object.assign(journal, change);
    await writeFile(file, JSON.stringify(journal));
  };
  return { journal, snapshots, file, log, save,
    run: (script, extra = {}) => runStorageCopyCommand({ file: process.execPath,
      args: ['-e', script], collect: true, timeoutMs: 5000, log, save, ...extra }) };
}
async function inspect(f) {
  const disk = JSON.parse(await readFile(f.file, 'utf8'));
  assert.deepEqual(disk, f.journal, 'the terminal diagnostic is actually persisted');
  const d = disk.copyProcess;
  assert.ok(d.startedAt > 0 && d.endedAt >= d.startedAt);
  assert.ok(d.elapsedMs >= 0);
  assert.equal(d.controllerPid, process.pid);
  if (d.pid) assert.throws(() => process.kill(d.pid, 0), { code: 'ESRCH' }, 'only the owned disposable child was reaped');
  return d;
}
function previousReceipt(f) {
  assert.deepEqual(f.journal.copyReceipt, receipt, 'failed/diagnostic-only attempts retain the completed receipt');
  assert.equal(f.journal.copyBaselineAt, 1000);
  assert.equal(f.journal.copiedAt, 2000);
}
async function failedPass(f, script, extra, pattern) {
  // Match the CLI's bookkeeping, including its interrupted-state catch.
  await assert.rejects(async () => {
    try {
      await runStorageCopyPass({ journal: f.journal, incremental: true, quiesced: true, save: f.save,
        copy: async () => JSON.parse(await f.run(script, extra)) });
    } catch (error) {
      await f.save({ state: 'interrupted', pid: null, error: error.message });
      throw error;
    }
  }, pattern);
  previousReceipt(f);
  assert.equal(f.journal.state, 'interrupted');
  return inspect(f);
}
try {
  const success = fixture();
  const output = await success.run('process.stdout.write("first\\n"); process.stderr.write("second\\n")');
  assert.ok(output.includes('first\n') && output.includes('second\n'));
  const good = await inspect(success);
  assert.equal(good.phase, 'exited'); assert.equal(good.exitCode, 0); assert.equal(good.signal, null);
  assert.ok(good.spawnedAt >= good.startedAt && good.spawnedAt <= good.endedAt);
  assert.equal(good.terminationReason, null); assert.equal(good.outputBytes, 13); assert.equal(good.loggedBytes, 13);
  assert.deepEqual(success.snapshots.map(s => s.copyProcess.phase), ['starting', 'running', 'exited']);
  previousReceipt(success);

  const signaled = fixture();
  const signal = await failedPass(signaled, 'process.kill(process.pid, "SIGTERM")', {}, /signal SIGTERM/);
  assert.equal(signal.exitCode, null); assert.equal(signal.signal, 'SIGTERM');
  assert.equal(signal.terminationReason, null, 'unknown signal origin is not labeled OOM or timeout');
  assert.deepEqual(signal.terminationRequests, []);

  const timeout = fixture();
  const timed = await failedPass(timeout, 'setInterval(() => {}, 1000)', { timeoutMs: 150 }, /signal SIGKILL.*timeout/);
  assert.equal(timed.signal, 'SIGKILL'); assert.equal(timed.exitCode, null);
  assert.equal(timed.terminationReason, 'timeout'); assert.equal(timed.terminationSignal, 'SIGKILL');
  assert.equal(timed.terminationSent, true); assert.ok(timed.terminationRequestedAt >= timed.startedAt);
  assert.equal(timed.terminationRequests.length, 1);
  assert.ok(timeout.snapshots.some(s => s.copyProcess?.terminationReason === 'timeout' && !s.copyProcess.endedAt));

  const missing = fixture();
  const notSpawned = await failedPass(missing, '', { file: join(root, 'missing-executable') }, /could not start \(ENOENT\)/);
  assert.equal(notSpawned.phase, 'spawn-failed'); assert.equal(notSpawned.pid, null);
  assert.equal(notSpawned.spawnErrorCode, 'ENOENT'); assert.equal(notSpawned.signal, null);
  assert.equal(notSpawned.spawnedAt, null);
  const invalidSpawn = fixture();
  const invalid = await failedPass(invalidSpawn, '', { file: '' }, /could not start \(ERR_INVALID_ARG_VALUE\)/);
  assert.equal(invalid.phase, 'spawn-failed'); assert.equal(invalid.pid, null);

  const nonzero = fixture();
  const badExit = await failedPass(nonzero, 'process.exit(7)', {}, /exited 7/);
  assert.equal(badExit.exitCode, 7); assert.equal(badExit.signal, null);

  const failingLog = fixture({ log: new Writable({ write(bytes, encoding, done) {
    setImmediate(() => done(Object.assign(Error('private log path'), { code: 'ENOSPC' })));
  } }) });
  const noLog = await failedPass(failingLog, 'process.stdout.write("progress\\n"); setInterval(() => {}, 1000)', {}, /Migration log unavailable.*ENOSPC/);
  assert.equal(noLog.signal, 'SIGTERM'); assert.equal(noLog.terminationReason, 'log-error');
  assert.equal(noLog.logErrorCode, 'ENOSPC'); assert.equal(noLog.terminationSent, true);

  const stubbornLog = fixture({ log: new Writable({ write(bytes, encoding, done) {
    done(Object.assign(Error('log failure'), { code: 'ENOSPC' }));
  } }) });
  const escalated = await failedPass(stubbornLog,
    'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)',
    { timeoutMs: 500 }, /Migration log unavailable.*ENOSPC/);
  assert.equal(escalated.signal, 'SIGKILL'); assert.equal(escalated.terminationReason, 'log-error');
  assert.deepEqual(escalated.terminationRequests.map(r => [r.reason, r.signal]),
    [['log-error', 'SIGTERM'], ['timeout', 'SIGKILL']], 'a prior termination request never disables the existing timeout backstop');

  // A delayed writable failure still fails the pass even if its child exited 0.
  const delayedLog = fixture({ log: new Writable({ write(bytes, encoding, done) {
    setTimeout(() => done(Object.assign(Error('late log error'), { code: 'EIO' })), 100);
  } }) });
  const late = await failedPass(delayedLog, 'process.stdout.write("{}")', {}, /Migration log unavailable.*EIO/);
  assert.equal(late.exitCode, 0); assert.equal(late.logErrorCode, 'EIO');

  const prefailedLog = fixture();
  const beforeSpawn = await failedPass(prefailedLog, '', {
    getLogError: () => Object.assign(Error('prior log error'), { code: 'EACCES' }),
  }, /Migration log unavailable.*EACCES/);
  assert.equal(beforeSpawn.phase, 'not-started'); assert.equal(beforeSpawn.pid, null);

  let failRunning = true;
  const failingJournal = fixture({ failSave: change => {
    if (failRunning && change.copyProcess?.phase === 'running') { failRunning = false; return true; }
    return false;
  } });
  const noJournal = await failedPass(failingJournal, 'setInterval(() => {}, 1000)', {}, /Migration diagnostics unavailable.*ENOSPC/);
  assert.equal(noJournal.signal, 'SIGTERM'); assert.equal(noJournal.terminationReason, 'journal-error');
  assert.equal(noJournal.journalErrorCode, 'ENOSPC');

  let failStarting = true;
  const unavailableJournal = fixture({ failSave: change => {
    if (failStarting && change.copyProcess?.phase === 'starting') { failStarting = false; return true; }
    return false;
  } });
  const noStart = await failedPass(unavailableJournal, 'setInterval(() => {}, 1000)', {}, /Migration diagnostics unavailable.*ENOSPC/);
  assert.equal(noStart.phase, 'not-started'); assert.equal(noStart.pid, null);
  assert.equal(noStart.terminationReason, null, 'an unavailable starting record never launches an orphan');

  const slowWrites = fixture();
  let writing = false;
  await slowWrites.run('process.stdout.write("done")', { save: async change => {
    assert.equal(writing, false, 'lifecycle snapshots must be serialized');
    writing = true;
    if (change.copyProcess.phase === 'running') await new Promise(resolve => setTimeout(resolve, 80));
    await slowWrites.save(change);
    writing = false;
  } });
  assert.equal((await inspect(slowWrites)).phase, 'exited', 'a slow running snapshot cannot overwrite the final record');

  const bounded = fixture();
  const boundedOutput = await bounded.run('process.stdout.write("x".repeat(2048))', { maxLogBytes: 32 });
  assert.equal(boundedOutput.length, 2048);
  assert.equal((await inspect(bounded)).loggedBytes, 32);
  const tooMuch = fixture();
  const exceeded = await failedPass(tooMuch, 'process.stdout.write("x".repeat(2048))',
    { maxOutputBytes: 64, maxLogBytes: 32 }, /output exceeded its bound/);
  assert.equal(exceeded.exitCode, 0); assert.equal(exceeded.terminationReason, null, 'output bounds never imply a kill');

  const completedPass = fixture();
  await runStorageCopyPass({ journal: completedPass.journal, incremental: true, quiesced: true, save: completedPass.save,
    copy: async () => JSON.parse(await completedPass.run('console.log(JSON.stringify({files: 5, unstableSources: []}))')) });
  assert.equal(completedPass.journal.copyReceipt.result.files, 5);
  assert.equal(completedPass.journal.copyReceipt.quiesced, true);
  assert.equal((await inspect(completedPass)).exitCode, 0);
  assert.ok(completedPass.journal.copyBaselineAt > 1000);

  const privateArg = fixture();
  await privateArg.run('/* private-argument-sentinel */ process.exit(0)');
  assert.ok(!JSON.stringify(privateArg.snapshots).includes('private-argument-sentinel'), 'diagnostics never serialize argv');
  assert.ok(!JSON.stringify(failingJournal.snapshots).includes('private failure detail'), 'diagnostics store bounded error codes only');
  console.log('storage_copy_command.test passed: signal/timeout/spawn/exit/log/journal diagnostics, output bounds, durable receipt retention');
} finally {
  for (const stream of streams) if (!stream.destroyed) await new Promise(resolve => stream.end(resolve));
  await rm(root, { recursive: true, force: true });
}
