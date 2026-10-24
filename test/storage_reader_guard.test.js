import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, lstat, readlink, rename, rmdir, rm, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), 'aios-storage-reader-')));
process.env.AIOS_DATA = join(root, 'control');
const { parseOpenFiles, parseStorageProcessIdentities, isReadOnlySpotlightOwner, assertUnused,
  assertTransferCutoverQuiesced, switchStorageRoot, durableJson } = await import('../src/storage_migration.js');
const { checkStorageTransfer } = await import('../src/storage_transfer_receipt.js');
const uid = process.getuid?.() || 501;
const executable = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/Metadata.framework/Versions/A/Support/mdworker_shared';
const identity = { pid: 701, uid, started: 'Fri Oct 23 18:25:30 2026', executable };
const owner = { pid: 701, uid, command: 'mdworker_shared', descriptor: '13', access: 'r', type: 'REG', path: '/work/p/file' };
const identities = () => new Map([[701, { ...identity }]]);
const qualifies = (entry = owner, before = identity, after = identity) => isReadOnlySpotlightOwner(entry, before, after, { platform: 'darwin', uid });
try {
  assert.equal(qualifies(), true);
  assert.equal(qualifies({ ...owner, type: 'DIR' }), true);
  for (const patch of [{ command: 'node' }, { command: 'mdworker' }, { command: undefined },
    { access: 'w' }, { access: 'u' }, { access: undefined }, { access: '' },
    { descriptor: 'cwd' }, { descriptor: 'txt' }, { descriptor: 'mem' }, { descriptor: '13r' }, { descriptor: undefined },
    { type: 'FIFO' }, { type: undefined }, { uid: uid + 1 }, { uid: 0 }, { uid: undefined }, { pid: undefined }]) {
    assert.equal(qualifies({ ...owner, ...patch }), false, JSON.stringify(patch));
  }
  for (const patch of [{ pid: 702 }, { uid: uid + 1 }, { executable: '/tmp/mdworker_shared' },
    { executable: executable + '-other' }, { started: 'Fri Oct 23 18:25:31 2026' }]) {
    assert.equal(qualifies(owner, identity, { ...identity, ...patch }), false, JSON.stringify(patch));
  }
  assert.equal(qualifies(owner, null, identity), false);
  assert.equal(qualifies(owner, identity, null), false);
  assert.equal(isReadOnlySpotlightOwner(owner, identity, identity, { platform: 'linux', uid }), false);
  const parsedIdentities = parseStorageProcessIdentities(`  701 ${uid} Fri Oct 23 18:25:30 2026     ${executable}\ninvalid row\n`);
  assert.deepEqual(parsedIdentities.get(701), identity);
  assert.equal(parsedIdentities.size, 1);
  const parsed = parseOpenFiles(`p701\0cmdworker_shared\0u${uid}\0\nf13\0ar\0tREG\0n/work/p/file\0\nf14\0n/work/p/unknown\0\np702\0\nf1\0n/work/p/new-owner\0\nf2\0n/work/prefix/no\0`, ['/work/p']);
  assert.deepEqual(parsed[0], owner);
  assert.equal(parsed[1].access, undefined, 'new descriptor cannot inherit read-only metadata');
  assert.equal(parsed[1].type, undefined);
  assert.equal(parsed[2].uid, undefined, 'new process cannot inherit UID or command');
  assert.equal(parsed[2].command, undefined);
  assert.equal(parsed.length, 3, 'path prefix lookalikes do not enter this inventory');
  await assert.rejects(assertUnused(['/work/p'], { inventory: async () => [owner] }), { code: 'storage-in-use' },
    'strict unused/reclamation guard still refuses even real read-only Spotlight');
  const order = [];
  const scan = { inventory: async () => { order.push('lsof'); return [owner]; },
    processInventory: async () => { order.push('ps'); return identities(); } };
  if (process.platform === 'darwin' && process.getuid() > 0) {
    const allowed = await assertTransferCutoverQuiesced(['/work/p'], scan);
    assert.deepEqual(order, ['ps', 'lsof', 'ps'], 'PID/start/executable identity brackets the actual handle inventory');
    assert.equal(allowed[0].executable, executable);
    assert.equal(allowed[0].started, identity.started);
    const writer = { ...owner, pid: 702, command: 'node', access: 'u' };
    await assert.rejects(assertTransferCutoverQuiesced(['/work/p'], { ...scan, inventory: async () => [owner, writer] }),
      error => error.code === 'storage-in-use' && error.owners.length === 1 && error.owners[0].pid === 702);
    let processReads = 0;
    await assert.rejects(assertTransferCutoverQuiesced(['/work/p'], { ...scan, processInventory: async () => ++processReads === 1 ? identities() : new Map() }),
      { code: 'storage-in-use' }, 'vanished or recycled process identity does not become an exception');
    await assert.rejects(assertTransferCutoverQuiesced(['/work/p'], { ...scan, inventory: async () => { throw Error('incomplete lsof'); } }), /incomplete lsof/);
    await assert.rejects(assertTransferCutoverQuiesced(['/work/p'], { ...scan, processInventory: async () => { throw Error('incomplete ps'); } }), /incomplete ps/);

    const source = join(root, 'original'), mount = join(root, 'mounts', 'spark'), target = join(mount, 'project');
    await mkdir(source); await mkdir(target, { recursive: true });
    for (const path of [source, target]) await writeFile(join(path, 'report.txt'), 'preserved report', { mode: 0o640 });
    await chmod(source, 0o750);
    await exec('/usr/bin/xattr', ['-w', 'com.aios.reader-guard', 'retained metadata', join(source, 'report.txt')]);
    const st = await lstat(source), originalFile = await lstat(join(source, 'report.txt')), copiedAt = Date.now();
    const journal = { id: 'reader-fixture', source, target, sourceInode: st.ino, sourceDevice: st.dev,
      state: 'copied', copiedAt, error: null, unstableSources: [],
      copyReceipt: { completedAt: copiedAt, exitCode: 0, quiesced: true, result: { files: 1, unstableSources: [] } } };
    const config = { version: 1, id: 'fixture', mount, mappings: [{ source, target }],
      migrationVerification: { version: 1, mode: 'transfer-only', storageId: 'fixture', approvedAt: Date.now(), retainOriginals: true,
        roots: [{ source, target, sourceInode: st.ino, sourceDevice: st.dev }] } };
    const evidence = await checkStorageTransfer(config, journal, { quiesced: true });
    const configFile = join(root, 'config.json'); await durableJson(configFile, config);
    const ownerChecks = [];
    const readGuard = paths => assertTransferCutoverQuiesced(paths, { processInventory: async () => identities(),
      inventory: async roots => { ownerChecks.push(roots); return roots.map(path => ({ ...owner, path: join(path, 'report.txt') })); } });
    const args = { source, target, configFile, journal, evidence,
      save: async changes => Object.assign(journal, changes), checkUnused: readGuard, checkMounted: async () => {},
      verifyMetadata: async () => { throw Error('Transfer-only must not perform content verification'); } };
    await assert.rejects(switchStorageRoot({ ...args, checkUnused: roots => assertTransferCutoverQuiesced(roots, {
      processInventory: async () => identities(), inventory: async () => [{ ...owner, access: 'u' }],
    }) }), { code: 'storage-in-use' });
    assert.equal((await lstat(source)).ino, st.ino, 'a writer cannot rename or alter the source');
    await rename(source, source + '-saved'); await mkdir(source);
    await assert.rejects(switchStorageRoot(args), /Source identity changed/, 'reader exception cannot waive root identity');
    await rmdir(source); await rename(source + '-saved', source);
    const result = await switchStorageRoot(args);
    assert.equal(result.sourceRetained, true); assert.equal(result.contentVerified, false);
    assert.equal(journal.reclaimedBytes, 0); assert.equal(journal.state, 'complete');
    assert.deepEqual(ownerChecks[0], [source, target]);
    assert.deepEqual(ownerChecks[1], [journal.retainedOriginal.path], 'retained quarantine is checked again after switching');
    assert.equal(journal.retainedReadOnlyIndexers[0].path, join(journal.retainedOriginal.path, 'report.txt'));
    assert.equal(await readlink(source), target);
    const held = await lstat(journal.retainedOriginal.path), heldFile = await lstat(join(journal.retainedOriginal.path, 'report.txt'));
    for (const field of ['ino', 'dev', 'uid', 'gid', 'mode']) assert.equal(held[field], st[field], 'root ' + field);
    for (const field of ['ino', 'dev', 'uid', 'gid', 'mode', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(heldFile[field], originalFile[field], 'file ' + field);
    assert.equal(await readFile(join(journal.retainedOriginal.path, 'report.txt'), 'utf8'), 'preserved report');
    assert.equal((await exec('/usr/bin/xattr', ['-p', 'com.aios.reader-guard', join(journal.retainedOriginal.path, 'report.txt')])).stdout.trim(), 'retained metadata');
  }
  console.log('storage reader guard passed: exact stable Apple identity/read-only handles only, strict reclaim, original inode/native metadata retained');
} finally { await rm(root, { recursive: true, force: true }); }
