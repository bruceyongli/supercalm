#!/usr/bin/env node
// Explicit storage migration, never deployment. copy/verify retain originals; cutover requires
// integrity verification (or explicit transfer-only consent retaining originals) and no open
// source/target writers before switching an alias. Only the original-retaining transfer path
// permits positively identified read-only Spotlight indexers; reclamation stays strict-unused.
import { spawn } from 'node:child_process';
import { mkdir, readFile, lstat, realpath, stat, open } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateLiveStorage } from '../src/live_storage.js';
import { verifyStoragePair, reuseStorageVerification, switchStorageRoot, assertUnused, assertTransferCutoverQuiesced, durableJson } from '../src/storage_migration.js';
import { transferOnlyAuthorized, checkStorageTransfer } from '../src/storage_transfer_receipt.js';
import { runStorageCopyPass } from '../src/storage_copy_baseline.js';
import { runStorageCopyCommand } from '../src/storage_copy_command.js';

const [operation, configFile, sourceArg] = process.argv.slice(2);
if (!['copy', 'reconcile', 'verify', 'cutover'].includes(operation) || !configFile || !sourceArg) {
  throw new Error('Usage: migrate-live-storage.mjs copy|reconcile|verify|cutover CONFIG SOURCE');
}
const config = validateLiveStorage(JSON.parse(await readFile(configFile, 'utf8')));
const source = resolve(sourceArg);
const mapping = config.mappings.find(m => m.source === source);
if (!mapping || !source.startsWith('/Users/') || source.split('/').length < 4
    || /\/proxy(?:\/|$)/.test(source) || /\.db(?:-|$)/.test(source)) throw new Error('Source is not an approved storage mapping');
const mount = resolve(config.mount), target = resolve(mapping.target);
if (!target.startsWith(mount + sep) || target.split('/').length < mount.split('/').length + 2) throw new Error('Destination is not a dedicated mounted-storage directory');
if (await realpath(mount) !== mount || (await stat(mount)).dev === (await stat(dirname(mount))).dev
    || (await readFile(join(mount, '.aios-storage-id'), 'utf8')).trim() !== config.id) throw new Error('Expected Spark volume is not mounted; refusing local fallback');
const id = createHash('sha256').update(source).digest('hex').slice(0, 20);
const journalRoot = resolve(config.journalRoot);
if (journalRoot.startsWith(source + sep) || journalRoot.startsWith(mount + sep)) throw new Error('Migration journal must remain on local control storage');
await mkdir(journalRoot, { recursive: true, mode: 0o700 });
const journalFile = join(journalRoot, id + '.json');
// Kernel-owned lease, released on exit/reboot. Never unlink a lock inode.
async function acquireLease(name) {
const lease = await open(join(journalRoot, name + '.lock'), 'a+', 0o600);
await new Promise((yes, no) => {
  const child = spawn('python3', ['-c', 'import fcntl\nfcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)'],
    { stdio: ['ignore', 'ignore', 'ignore', lease.fd] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.on('error', e => { clearTimeout(timer); no(e); });
  child.on('close', code => { clearTimeout(timer); code === 0 ? yes() : no(Error('Another transfer owns this source; originals retained')); });
});
return lease;
}
const lease = await acquireLease(id);
let configLease = null;
let journal;
try { journal = JSON.parse(await readFile(journalFile, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
const original = await lstat(source);
if (!journal) {
  if (!original.isDirectory() || original.isSymbolicLink() || await realpath(source) !== source) throw new Error('New source must be a physical directory');
  journal = { version: 1, source, target, id, createdAt: Date.now(), sourceInode: original.ino, sourceDevice: original.dev,
    state: 'planned' };
  try { await lstat(target); throw new Error('Destination already exists without a migration journal'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
if (journal.source !== source || journal.target !== target) throw new Error('Migration identity changed');
const save = async changes => {
  Object.assign(journal, changes, { updatedAt: Date.now() });
  await durableJson(journalFile, journal);
};
const log = createWriteStream(join(journalRoot, id + '.log'), { flags: 'a', mode: 0o600 });
let logError = null;
log.on('error', error => { logError = error; });
async function stageCopy(incremental, { quiesced = false } = {}) {
  return runStorageCopyPass({ journal, incremental, quiesced, save, copy: async ({ baseline }) => {
      await mkdir(target, { recursive: true, mode: original.mode & 0o777 });
      // Native copyfile preserves ACL/xattrs/hardlinks without Apple's openrsync AppleDouble
      // hardlink bug. Superseded staging entries stay on Spark, never silently deleted.
      const revisions = join(mount, 'migration-revisions', id, String(Date.now()));
      const args = [fileURLToPath(new URL('../scripts/storage-copy.py', import.meta.url)), source, target, revisions];
      if (mapping.ephemeralSockets === true) args.push('--ephemeral-sockets');
      // Only completed staging qualifies. A source-only reconcile is NOT an integrity
      // proof: default cutover still verifies contents; an explicit transfer-only
      // policy can skip rereads only while retaining the exact local original.
      if (incremental) args.push('--since=' + String((baseline - 1000) / 1000));
      const output = await runStorageCopyCommand({ file: 'python3', args, collect: true,
        log, save, getLogError: () => logError, logName: id + '.log' });
      return JSON.parse(output.trim().split('\n').at(-1));
  } });
}
try {
  {
    if (!original.isDirectory() || original.ino !== journal.sourceInode || original.dev !== journal.sourceDevice) throw new Error('Source identity changed; inspect journal before recovery');
    if (operation === 'copy' || operation === 'reconcile') {
      await stageCopy(operation === 'reconcile');
      console.log(JSON.stringify({ copied: source, target, journal: journalFile, sourceRetained: true, unstableSources: journal.unstableSources }));
    } else {
      const transferOnly = transferOnlyAuthorized(config, journal);
      const checkOwners = transferOnly ? assertTransferCutoverQuiesced : assertUnused;
      if (operation === 'cutover') await checkOwners([source, target]);
      let verification;
      if (transferOnly) {
        // A background receipt cannot approve a live switch. Reconcile after the
        // final owner pause even when a preparation check already succeeded.
        if (operation === 'cutover' || !journal.copyReceipt || journal.error) {
          await stageCopy(true, { quiesced: operation === 'cutover' });
        }
        if (operation === 'cutover') await checkOwners([source, target]);
        verification = await checkStorageTransfer(config, journal, { quiesced: operation === 'cutover' });
      } else {
      const options = {
        ephemeralSockets: mapping.ephemeralSockets === true, equivalentGroups: mapping.equivalentGroups || [],
      };
      const reused = journal.state === 'verified'
        ? await reuseStorageVerification(source, target, journal.verification, options) : null;
      verification = reused || await verifyStoragePair(source, target, options);
      }
      await save({ state: transferOnly ? 'transfer-checked' : 'verified', verifiedAt: transferOnly ? null : Date.now(), checkedAt: Date.now(), verification, error: null });
      if (operation === 'cutover') {
        // Integrity reads do not mutate shared configuration. Serialize only the actual
        // alias transaction; a large verification must not stall unrelated cutovers.
        configLease = await acquireLease('config');
        console.log(JSON.stringify(await switchStorageRoot({ source, target, configFile, journal, save, evidence: verification })));
      } else console.log(JSON.stringify({ ...(transferOnly ? { transferChecked: source } : { verified: source }), target, verification, sourceRetained: true }));
    }
  }
} catch (error) {
  await save({ ...(['copy', 'reconcile'].includes(operation) || journal.state === 'copying'
    ? { state: 'interrupted', pid: null } : {}), error: error.message });
  throw error;
} finally { if (!log.destroyed) await new Promise(resolve => log.end(resolve)); await configLease?.close(); await lease.close(); }
