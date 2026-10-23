import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, readlink, lstat, rm, chmod, chown, realpath, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), 'aios-storage-migration-')));
process.env.AIOS_DATA = join(root, 'control-data');
const { storageManifest, verifyStoragePair, reuseStorageVerification, switchStorageRoot, durableJson, parseOpenFiles } = await import('../src/storage_migration.js');
const source = join(root, 'original'), mount = join(root, 'mounts', 'spark'), target = join(mount, 'data', 'project');
try {
  const large = join(root, 'large'); await mkdir(large);
  const largeFile = join(large, 'file'); await writeFile(largeFile, Buffer.alloc(2 * 1024 * 1024, 'a'));
  const largeFirst = await storageManifest(large);
  const largeAgain = await storageManifest(large);
  assert.equal(largeFirst.uniqueContentReads, 1);
  assert.equal(largeAgain.uniqueContentReads, 0);
  assert.equal(largeAgain.largeContentCacheHits, 1);
  assert.equal(largeAgain.digest, largeFirst.digest);
  const largeInfo = await lstat(largeFile);
  await writeFile(largeFile, Buffer.alloc(2 * 1024 * 1024, 'b'));
  await utimes(largeFile, largeInfo.atime, largeInfo.mtime);
  const largeChanged = await storageManifest(large);
  assert.equal(largeChanged.uniqueContentReads, 1, 'same-size writes with restored mtime still invalidate the content proof through ctime');
  assert.notEqual(largeChanged.digest, largeFirst.digest);
  await mkdir(source); await mkdir(target, { recursive: true });
  await writeFile(join(source, '中文.md'), 'persisted report\n');
  await chmod(join(source, '中文.md'), 0o600);
  await link(join(source, '中文.md'), join(source, 'hardlink'));
  await symlink('中文.md', join(source, 'relative'));
  await symlink('/deliberately-missing-reference', join(source, 'dangling'));
  if (process.platform === 'darwin') {
    const delta = join(root, 'delta'), deltaCopy = join(root, 'delta-copy');
    await mkdir(join(delta, 'nested'), { recursive: true }); await mkdir(deltaCopy);
    await writeFile(join(delta, 'nested', 'edited'), 'before');
    await writeFile(join(delta, 'untouched'), 'unchanged');
    await writeFile(join(delta, 'removed'), 'retained revision');
    const copier = fileURLToPath(new URL('../scripts/storage-copy.py', import.meta.url));
    await exec('python3', [copier, delta, deltaCopy, join(root, 'delta-revisions')]);
    const baseline = Date.now() / 1000;
    const beforeEdit = await lstat(join(delta, 'nested', 'edited'));
    await new Promise(r => setTimeout(r, 20));
    await writeFile(join(delta, 'nested', 'edited'), 'after!');
    await utimes(join(delta, 'nested', 'edited'), beforeEdit.atime, beforeEdit.mtime);
    await writeFile(join(delta, 'added'), 'new');
    await rm(join(delta, 'removed'));
    const reconciled = JSON.parse((await exec('python3', [copier, delta, deltaCopy, join(root, 'delta-revisions'), '--since=' + baseline])).stdout.trim().split('\n').at(-1));
    assert.ok(reconciled.unchangedSinceBaseline >= 1);
    await verifyStoragePair(delta, deltaCopy);
    assert.equal(await readFile(join(root, 'delta-revisions', 'removed'), 'utf8'), 'retained revision');
    assert.equal(await readFile(join(deltaCopy, 'nested', 'edited'), 'utf8'), 'after!', 'ctime detects same-size edits with restored mtime');
    await writeFile(join(deltaCopy, 'untouched'), 'CORRUPTED');
    await exec('python3', [copier, delta, deltaCopy, join(root, 'delta-revisions'), '--since=' + baseline]);
    await assert.rejects(verifyStoragePair(delta, deltaCopy), /differ/, 'a source-only reconciliation never grants approval to an altered destination');
    const outside = join(root, 'outside'); await mkdir(outside);
    await writeFile(join(outside, 'edited'), 'must remain untouched');
    await rm(join(deltaCopy, 'nested'), { recursive: true });
    await symlink(outside, join(deltaCopy, 'nested'));
    const secondBaseline = Date.now() / 1000;
    await new Promise(r => setTimeout(r, 20));
    await writeFile(join(delta, 'nested', 'edited'), 'changed again');
    await assert.rejects(exec('python3', [copier, delta, deltaCopy, join(root, 'delta-revisions'), '--since=' + secondBaseline]), /ancestor changed/);
    assert.equal(await readFile(join(outside, 'edited'), 'utf8'), 'must remain untouched');
    await exec('/usr/bin/xattr', ['-w', 'com.aios.migration-test', 'attribute value', join(source, '中文.md')]);
    await exec('/bin/chmod', ['+a', 'everyone allow read', join(source, '中文.md')]);
    await exec('python3', [fileURLToPath(new URL('../scripts/storage-copy.py', import.meta.url)), source, target, join(mount, 'revisions')]);
  } else await exec('cp', ['-a', source + '/.', target]);
  const evidence = await verifyStoragePair(source, target);
  assert.equal(await reuseStorageVerification(source, target, evidence), evidence);
  assert.equal(evidence.files, 2); assert.equal(evidence.links, 2);
  assert.equal(evidence.uniqueContentReads, 1, 'hardlinked contents are independently read once per verified inode version');
  assert.equal(evidence.bytes, 2 * Buffer.byteLength('persisted report\n'));
  await writeFile(join(target, '中文.md'), 'wrong data\n');
  assert.equal(await reuseStorageVerification(source, target, evidence), null, 'modified destination invalidates cached content verification');
  await assert.rejects(verifyStoragePair(source, target), /differ/);
  await writeFile(join(target, '中文.md'), 'persisted report\n');
  await verifyStoragePair(source, target);
  if (process.platform === 'darwin') {
    await exec('/usr/bin/xattr', ['-w', 'com.aios.migration-test', 'wrong', join(target, '中文.md')]);
    await assert.rejects(verifyStoragePair(source, target), /differ/);
    await exec('/usr/bin/xattr', ['-w', 'com.aios.migration-test', 'attribute value', join(target, '中文.md')]);
    const changing = join(root, 'changing'), staged = join(root, 'staged');
    await mkdir(changing); await mkdir(staged);
    await writeFile(join(changing, 'a'), 'initial'); await writeFile(join(changing, 'z'), 'later file');
    const script = `import importlib.util,sys,os,json
spec=importlib.util.spec_from_file_location('copy',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
original=m.native_copy
def racing(src,dst,metadata=False):
 original(src,dst,metadata)
 if not metadata and os.path.basename(src)=='a':
  with open(src,'a') as stream: stream.write(' changed')
m.native_copy=racing
print(json.dumps(m.copy_tree(sys.argv[2],sys.argv[3],sys.argv[4])))`;
    const stagedResult = JSON.parse((await exec('python3', ['-B', '-c', script,
      fileURLToPath(new URL('../scripts/storage-copy.py', import.meta.url)), changing, staged, join(root, 'changing-revisions')])).stdout);
    assert.deepEqual(stagedResult.unstableSources, ['a']);
    assert.equal(await readFile(join(staged, 'z'), 'utf8'), 'later file', 'a growing active transcript cannot starve later histories');
    await assert.rejects(verifyStoragePair(changing, staged), /differ/, 'staging never authorizes an unsafe cutover');
    const linked = join(root, 'many-links'), linkedCopy = join(root, 'many-links-copy');
    await mkdir(linked); await mkdir(linkedCopy);
    await writeFile(join(linked, 'owner'), 'shared package bytes');
    for (let n = 0; n < 120; n++) await link(join(linked, 'owner'), join(linked, 'link-' + n));
    await exec('python3', [fileURLToPath(new URL('../scripts/storage-copy.py', import.meta.url)), linked, linkedCopy, join(root, 'link-revisions')]);
    const linkedEvidence = await verifyStoragePair(linked, linkedCopy);
    assert.equal(linkedEvidence.files, 121); assert.equal(linkedEvidence.uniqueContentReads, 1);
    const originalCopyInode = (await lstat(join(linkedCopy, 'owner'))).ino;
    await exec('python3', [fileURLToPath(new URL('../scripts/storage-copy.py', import.meta.url)), linked, linkedCopy, join(root, 'link-revisions')]);
    assert.equal((await lstat(join(linkedCopy, 'owner'))).ino, originalCopyInode, 'parallel reconciliation preserves a correct existing hardlink group');
    await verifyStoragePair(linked, linkedCopy);
    const packages = join(root, 'packages'), packageCopy = join(root, 'packages-copy');
    await mkdir(packages); await mkdir(packageCopy);
    for (let n = 0; n < 48; n++) {
      const directory = join(packages, 'package-' + n, 'nested');
      await mkdir(directory, { recursive: true });
      await link(join(linked, 'owner'), join(directory, 'shared'));
      await writeFile(join(directory, 'unique'), String(n));
    }
    await mkdir(join(packageCopy, 'package-0', 'nested'), { recursive: true });
    await writeFile(join(packageCopy, 'package-0', 'nested', 'old'), 'retain extra');
    await exec('python3', [fileURLToPath(new URL('../scripts/storage-copy.py', import.meta.url)), packages, packageCopy, join(root, 'package-revisions')]);
    const packageEvidence = await verifyStoragePair(packages, packageCopy);
    assert.equal(packageEvidence.files, 96);
    assert.equal(packageEvidence.uniqueContentReads, 49, 'hardlinks across tiny directories retain their shared inode');
    assert.equal(await readFile(join(root, 'package-revisions', 'package-0', 'nested', 'old'), 'utf8'), 'retain extra');
  }
  assert.deepEqual(parseOpenFiles('p7\0cwriter\0\nf2\0n/work/p/data\0\nf3\0n/work/prefix/no\0', ['/work/p']),
    [{ pid: 7, command: 'writer', descriptor: '2', path: '/work/p/data' }]);
  assert.equal(parseOpenFiles('p7\0cwriter\0\nfcwd\0n/work/p\0', ['/'])[0].path, '/work/p');
  const configFile = join(root, 'config.json');
  await durableJson(configFile, { version: 1, id: 'fixture', mount, mappings: [{ source, target }] });
  const st = await lstat(source);
  const journal = { id: 'fixture', sourceInode: st.ino, sourceDevice: st.dev };
  const states = [];
  const save = async change => { Object.assign(journal, change); states.push(change.state); };
  const latest = await verifyStoragePair(source, target);
  await assert.rejects(switchStorageRoot({ source, target, configFile, journal, save, evidence: latest,
    checkUnused: async () => { throw Error('owned by a live writer'); } }), /live writer/);
  assert.equal((await lstat(source)).isDirectory(), true);
  await switchStorageRoot({ source, target, configFile, journal, save, evidence: latest,
    checkUnused: async () => {}, checkMounted: async () => {} });
  assert.equal(await readlink(source), target);
  assert.equal((await readFile(join(source, '中文.md'), 'utf8')), 'persisted report\n');
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).mappings[0].active, true);
  assert.deepEqual(states, ['switching', 'switched', 'reclaiming', 'complete']);
  assert.equal(journal.quarantine, null);
  const readonlySource=join(root,'readonly-source'),readonlyTarget=join(mount,'readonly-copy');
  await mkdir(join(readonlySource,'locked'),{recursive:true});await mkdir(join(readonlyTarget,'locked'),{recursive:true});
  for(const directory of [readonlySource,readonlyTarget]) {
    await writeFile(join(directory,'locked','report.txt'),'preserved read-only report',{mode:0o444});
    await chmod(join(directory,'locked'),0o555);
  }
  // A symlink in the duplicate must not cause chmod in another tree.
  const untouched=join(root,'not-a-duplicate');await mkdir(untouched);await chmod(untouched,0o555);
  await symlink(untouched,join(readonlySource,'external'));await symlink(untouched,join(readonlyTarget,'external'));
  await durableJson(configFile,{version:1,id:'fixture',mount,mappings:[{source:readonlySource,target:readonlyTarget}]});
  const readonlyInfo=await lstat(readonlySource),readonlyEvidence=await verifyStoragePair(readonlySource,readonlyTarget);
  const readonlyJournal={id:'readonly-fixture',sourceInode:readonlyInfo.ino,sourceDevice:readonlyInfo.dev};
  await switchStorageRoot({source:readonlySource,target:readonlyTarget,configFile,journal:readonlyJournal,
    save:async change=>Object.assign(readonlyJournal,change),evidence:readonlyEvidence,
    checkUnused:async()=>{},checkMounted:async()=>{}});
  assert.equal(readonlyJournal.state,'complete');assert.equal(readonlyJournal.writableDuplicateDirectories,1);
  assert.equal((await lstat(join(readonlyTarget,'locked'))).mode&0o777,0o555,'live Spark permissions remain untouched');
  assert.equal((await lstat(untouched)).mode&0o777,0o555,'never traverse an external symlink during duplicate reclamation');
  assert.equal(await readFile(join(readonlySource,'locked','report.txt'),'utf8'),'preserved read-only report');
  await chmod(join(readonlyTarget,'locked'),0o755);await chmod(untouched,0o755); // Own fixture cleanup only.
  if (process.platform === 'darwin' && process.getgroups().includes(12) && process.getgid() !== 12) {
    const a = join(root, 'groups-source'), b = join(root, 'groups-target');
    await mkdir(a); await mkdir(b); await writeFile(join(a, 'plain.txt'), 'same content'); await writeFile(join(b, 'plain.txt'), 'same content');
    await chown(b, process.getuid(), 12); await chown(join(b, 'plain.txt'), process.getuid(), 12);
    await assert.rejects(verifyStoragePair(a, b), /differ/);
    const sourceGid = (await lstat(a)).gid; // BSD directories inherit their parent's group.
    const normalized = await verifyStoragePair(a, b, { equivalentGroups: [{ from: sourceGid, to: 12 }] });
    assert.equal(normalized.equivalentGroupChanges.length, 2, 'the original labels remain in the audit evidence');
    await chmod(join(a, 'plain.txt'), 0o640);
    await assert.rejects(verifyStoragePair(a, b, { equivalentGroups: [{ from: sourceGid, to: 12 }] }), /Group change would alter access/);
  }
  console.log('storage migration: integrity, xattrs/ACLs, hardlinks, aliases, busy guard and verified cutover passed');
} finally { await rm(root, { recursive: true, force: true }); }
