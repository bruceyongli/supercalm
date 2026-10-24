import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, readFile, writeFile, lstat, rm, symlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';

const root = await realpath(await mkdtemp(join(tmpdir(), 'aios-storage-settings-')));
process.env.AIOS_DATA = join(root, 'api-data');
process.env.AIOS_WORKTREE_ROOT = join(root, 'api-worktrees');
delete process.env.AIOS_LIVE_STORAGE_CONFIG;
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
process.env.AIOS_TMUX = '/usr/bin/false'; process.env.AIOS_HOST = '127.0.0.1'; process.env.AIOS_PORT = String(port);
process.env.AIOS_SUMMARY_PORT = '1'; delete process.env.AIOS_NO_LISTEN;
const { createStorageSettings, storageDeviceInput, storageSettings } = await import('../src/storage_settings.js');
const { validateLiveStorage } = await import('../src/live_storage.js');
const { durableJson } = await import('../src/storage_migration.js');
const { withStorageConfigLock } = await import('../src/storage_provision.js');
const secret = 'fixture-credential-not-for-responses'; // secret-scan: allow -- synthetic redaction fixture, not a credential
const input = { label: 'Spark fixture', url: 'smb://192.0.2.10/storage', account: 'fixture-user', password: secret, sizeGiB: 512 };
let store;
async function fixture(name) {
  const data = join(root, name, 'data'), projectParent = join(root, name, 'projects'), worktrees = join(root, name, 'worktrees');
  await mkdir(join(root, name));
  await Promise.all([mkdir(data, { recursive: true }), mkdir(projectParent), mkdir(worktrees)]);
  const pointer = join(data, 'live-storage.json');
  const currentFile = () => {
    try { return JSON.parse(readFileSync(pointer, 'utf8')).configFile || pointer; }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  };
  const current = () => currentFile() ? validateLiveStorage(JSON.parse(readFileSync(currentFile(), 'utf8'))) : null;
  const credentials = [], connections = [], available = new Set();
  const options = { data, projectParent, worktrees, current, currentFile, platform: 'darwin', pinnedConfig: false,
    status: config => ({ available: available.has(config.id), migrated_roots: config.mappings.filter(m => m.active).length }),
    saveCredential: async (config, password) => credentials.push({ service: config.service, password }),
    connect: async (config, file, settings) => { connections.push({ config, file, settings }); available.add(config.id); } };
  return { ...options, options, manager: createStorageSettings(options), credentials, connections, available };
}
try {
  for (const body of [null, [], {}, { ...input, url: 'https://example.com/storage' }, { ...input, url: 'smb://user:secret@host/share' },
    { ...input, url: 'smb://host/share/subfolder' }, { ...input, url: 'smb://host/share%2Fsubfolder' },
    { ...input, url: 'smb://host/share%xx' }, { ...input, sizeGiB: 1 }, { ...input, sizeGiB: 1024.5 }]) {
    assert.throws(() => storageDeviceInput(body), e => e.status === 400);
  }
  assert.equal(storageDeviceInput({ ...input, url: 'smb://host/%E6%96%87%E4%BB%B6/' }).url, 'smb://host/%E6%96%87%E4%BB%B6');
  const clean = await fixture('clean');
  let snapshot = await clean.manager.snapshot();
  assert.equal(snapshot.defaultDevice, 'local'); assert.equal(snapshot.localIsFactoryDefault, true);
  assert.deepEqual(snapshot.devices, []); assert.equal(snapshot.migration, null);
  await assert.rejects(createStorageSettings({ ...clean.options, platform: 'linux' }).add(input), /requires a macOS/);
  const added = await clean.manager.add(input), id = added.id;
  assert.equal(added.defaultDevice, 'local', 'adding a device never changes the selected destination');
  assert.equal(clean.credentials.length, 1); assert.equal(clean.credentials[0].password, secret);
  assert.equal(clean.connections.length, 0, 'saving credentials does not mount or migrate data');
  const deviceFile = join(clean.data, 'storage-devices', id, 'config.json');
  assert.equal((await lstat(deviceFile)).mode & 0o777, 0o600);
  for (const text of [JSON.stringify(added), await readFile(deviceFile, 'utf8'), await readFile(join(clean.data, 'storage-settings.json'), 'utf8')]) {
    assert.ok(!text.includes(secret)); assert.doesNotMatch(text, /"password"/);
  }
  await assert.rejects(clean.manager.select(id), e => e.status === 409 && /connection/.test(e.message));
  await assert.rejects(createStorageSettings({ ...clean.options, connect: async () => {} }).connect(id), e => e.status === 503 && /healthy connection/.test(e.message));
  snapshot = await clean.manager.connect(id);
  assert.equal(snapshot.devices[0].available, true); assert.equal(clean.connections[0].settings.existing, false);
  snapshot = await clean.manager.select(id);
  assert.equal(snapshot.defaultDevice, id); assert.equal(snapshot.devices[0].current, true);
  assert.deepEqual(clean.current().newRoots.map(p => p.kind), ['project', 'worktree', 'session', 'artifacts']);
  assert.equal(clean.current().mappings.length, 0, 'select never moves existing files');
  const mappedSource = join(clean.projectParent, 'existing'), mappedTarget = join(clean.current().mount, 'projects', 'existing');
  await mkdir(mappedTarget, { recursive: true }); await writeFile(join(mappedTarget, 'keep.txt'), 'keep existing files');
  await symlink(mappedTarget, mappedSource);
  const live = { ...clean.current(), mappings: [{ source: mappedSource, target: mappedTarget, active: true }],
    newRoots: clean.current().newRoots.map(p => p.kind === 'project' ? { ...p, targetParent: join(clean.current().mount, 'custom-layout', 'projects') } : p) };
  await durableJson(deviceFile, live);
  await clean.manager.connect(id);
  assert.equal(clean.connections.at(-1).settings.existing, true, 'selected device is never recreated by reconnect');
  snapshot = await clean.manager.select('local');
  assert.equal(snapshot.defaultDevice, 'local'); assert.deepEqual(clean.current().newRoots, []);
  assert.deepEqual(clean.current().mappings, live.mappings);
  assert.equal(await readFile(join(mappedSource, 'keep.txt'), 'utf8'), 'keep existing files');
  assert.equal(await realpath(mappedSource), mappedTarget);
  await clean.manager.select(id);
  assert.deepEqual(clean.current().newRoots, live.newRoots, 're-enabling restores the imported destination layout');
  await clean.manager.select('local');
  const other = await clean.manager.add({ ...input, label: 'Other device' }); await clean.manager.connect(other.id);
  await assert.rejects(clean.manager.select(other.id), e => e.status === 409 && /Existing files/.test(e.message));
  assert.equal(clean.current().id, id, 'registered remote mappings cannot be abandoned by Settings');
  await withStorageConfigLock(clean.current(), async () => {
    await assert.rejects(clean.manager.select(id), e => e.status === 409 && /being updated/.test(e.message));
  });
  await durableJson(deviceFile, { ...live, retainDuringMigration: true });
  await assert.rejects(clean.manager.select('local'), e => e.status === 409 && /migration/.test(e.message));
  snapshot = await clean.manager.snapshot();
  assert.equal(snapshot.migration.running, true); assert.equal(snapshot.migration.total, 1);
  assert.equal(await readFile(join(mappedSource, 'keep.txt'), 'utf8'), 'keep existing files');

  const imported = await fixture('imported'), importedFile = join(imported.data, 'spark-config.json');
  const importedConfig = { ...live, id: 'existing-spark', label: 'Current Spark', mappings: [], newRoots: [], retainDuringMigration: true };
  await durableJson(importedFile, importedConfig); await durableJson(join(imported.data, 'live-storage.json'), { configFile: importedFile });
  assert.equal((await imported.manager.snapshot()).defaultDevice, 'existing-spark', 'adopt existing Spark instead of silently selecting Local');
  assert.equal(await readFile(importedFile, 'utf8'), JSON.stringify(importedConfig, null, 2), 'snapshot is read-only');
  const pinned = await fixture('pinned'); const pinnedDevice = await pinned.manager.add(input); await pinned.manager.connect(pinnedDevice.id);
  await assert.rejects(createStorageSettings({ ...pinned.options, pinnedConfig: true }).select(pinnedDevice.id), e => e.status === 409 && /pinned/.test(e.message));

  // Real registered HTTP handlers, private data root, injected connection/Keychain
  // operations. No host mounts, credentials, native sessions, or production DB writes.
  const api = await fixture('api'); Object.assign(storageSettings, api.manager);
  const { featureReady } = await import('../src/server.js'); await featureReady;
  store = await import('../src/store.js');
  const request = async (path = '', body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/settings/storage${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const value = await response.json(); assert.ok(!JSON.stringify(value).includes(secret));
    return { status: response.status, body: value };
  };
  assert.equal((await request()).body.defaultDevice, 'local');
  assert.equal((await request('/devices', null)).status, 400);
  assert.equal((await request('/default', {})).status, 400);
  assert.equal((await request('/devices/missing/connect', {})).status, 404);
  const saved = await request('/devices', input); assert.equal(saved.status, 200);
  assert.equal((await request(`/devices/${saved.body.id}/credentials`, { password: '' })).status, 400);
  assert.equal((await request(`/devices/${saved.body.id}/credentials`, { password: secret })).status, 200);
  assert.equal(api.credentials.length, 2);
  assert.equal((await request(`/devices/${saved.body.id}/connect`, {})).status, 200);
  assert.equal((await request('/default', { device: saved.body.id })).body.defaultDevice, saved.body.id);
  assert.equal((await request('/default', { device: 'local' })).body.defaultDevice, 'local');
  console.log('storage settings passed: local defaults, Spark adoption, credential redaction, real HTTP routes, migration/config leases and no implicit moves');
} finally { store?.db.close(); await rm(root, { recursive: true, force: true }); }
process.exit(0);
