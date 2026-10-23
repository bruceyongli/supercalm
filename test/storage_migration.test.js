import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, readlink, lstat, rm, chmod, chown, realpath } from 'node:fs/promises';
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
  await mkdir(source); await mkdir(target, { recursive: true });
  await writeFile(join(source, '中文.md'), 'persisted report\n');
  await chmod(join(source, '中文.md'), 0o600);
  await link(join(source, '中文.md'), join(source, 'hardlink'));
  await symlink('中文.md', join(source, 'relative'));
  await symlink('/deliberately-missing-reference', join(source, 'dangling'));
  if (process.platform === 'darwin') {
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
    const stagedResult = JSON.parse((await exec('python3', ['-c', script,
      fileURLToPath(new URL('../scripts/storage-copy.py', import.meta.url)), changing, staged, join(root, 'changing-revisions')])).stdout);
    assert.deepEqual(stagedResult.unstableSources, ['a']);
    assert.equal(await readFile(join(staged, 'z'), 'utf8'), 'later file', 'a growing active transcript cannot starve later histories');
    await assert.rejects(verifyStoragePair(changing, staged), /differ/, 'staging never authorizes an unsafe cutover');
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
