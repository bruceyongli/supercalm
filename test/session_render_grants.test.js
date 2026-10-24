import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const fixture = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'aios-render-grants-')));
// Dedicated test storage deliberately sits outside the generic host-temp
// allowance, so a stale grant is tested against an actually revoked scope.
const testRoot = join(homedir(), '.local', 'share', 'aios', 'test-tmp');
await fs.mkdir(testRoot, { recursive: true });
const outside = await fs.mkdtemp(join(testRoot, 'render-grant-scope-'));
const project = join(fixture, 'project'), data = join(fixture, 'data');
await fs.mkdir(project);
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
Object.assign(process.env, {
  AIOS_DATA: data, AIOS_WORKTREE_ROOT: join(fixture, 'worktrees'),
  AIOS_CODEX_SESSIONS_DIR: join(fixture, 'native'), AIOS_TMUX: '/usr/bin/false',
  AIOS_HOST: '127.0.0.1', AIOS_PORT: String(port), AIOS_SUMMARY_PORT: '1',
  AIOS_LIVE_STORAGE_CONFIG: join(data, 'live-storage.json'),
});
delete process.env.AIOS_NO_LISTEN;
let store, originalOpen;
const openedLogs = [];
try {
  const { featureReady } = await import('../src/server.js');
  await featureReady;
  store = await import('../src/store.js');
  const { sessionStoragePaths } = await import('../src/session_storage.js');
  const { renderedFileMeta, hasApprovedRenderedEntry } = await import('../src/file_render.js');
  store.createProject({ id: 'p_grants', name: 'Preview fixture', path: project });
  for (const id of ['s_granted', 's_neighbor', 's_changed']) {
    store.createSession({ id, project_id: 'p_grants', tool: 'codex', tmux: `fixture-${id}`, status: 'exited' });
    store.updateSession(id, { status_reason: 'operator-kill' });
    await fs.writeFile(join(data, 'logs', `${id}.log`), 'No artifact paths in this terminal.');
  }
  const artifacts = sessionStoragePaths('s_granted').artifacts;
  await fs.mkdir(artifacts, { recursive: true });
  const entry = join(artifacts, 'dashboard.html'), neighbor = join(artifacts, 'neighbor.html');
  const text = '<!doctype html><h1>Previously approved report</h1>';
  await fs.writeFile(entry, text);
  await fs.writeFile(neighbor, '<h1>Never approved</h1>');
  // Simulate the persisted server-issued record from a previous process. There
  // is intentionally no message, event, transcript or in-memory mention grant.
  const rendered = renderedFileMeta('s_granted', entry, Buffer.byteLength(text));
  assert.equal(hasApprovedRenderedEntry('s_granted', entry), true);
  assert.equal(hasApprovedRenderedEntry('s_neighbor', entry), false);
  assert.equal(hasApprovedRenderedEntry('s_granted', neighbor), false);
  assert.equal(hasApprovedRenderedEntry('s_granted', artifacts), false);
  assert.equal(hasApprovedRenderedEntry('s_granted', 'dashboard.html'), false);
  originalOpen = fs.open;
  fs.open = async function(path, ...args) {
    if (String(path).startsWith(join(data, 'logs') + '/')) openedLogs.push(String(path));
    return originalOpen.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  const base = `http://127.0.0.1:${port}`;
  const getFile = (id, path, extra = '') => fetch(`${base}/api/session/${id}/file?path=${encodeURIComponent(path)}${extra}`,
    { signal: AbortSignal.timeout(10_000) });
  const initial = await getFile('s_granted', entry);
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).renderUrl, rendered.renderUrl);
  assert.equal(await (await getFile('s_granted', entry, '&raw=1')).text(), text);
  const hosted = await fetch(`${base}/${rendered.renderUrl}`);
  assert.equal(hosted.status, 200);
  assert.equal(await hosted.text(), text);
  assert.deepEqual(openedLogs, [], 'existing exact approval avoids terminal/history lookup on all preview routes');

  assert.equal((await getFile('s_neighbor', entry)).status, 403, 'a different session cannot borrow the entry grant');
  assert.equal((await getFile('s_granted', neighbor)).status, 403, 'a grant is not a directory mention');
  assert.equal((await fetch(`${base}/${rendered.renderUrl.replace('s_granted/', 's_neighbor/')}`)).status, 404,
    'render tokens remain session-bound');

  // Keep the old entry name, replace its contents with an escaping symlink.
  const secret = join(outside, 'secret.html');
  await fs.writeFile(secret, '<h1>Outside the session</h1>');
  await fs.unlink(entry);
  await fs.symlink(secret, entry);
  assert.equal((await getFile('s_granted', entry)).status, 403, 'an exact old grant cannot bless a new symlink target');
  assert.equal((await fetch(`${base}/${rendered.renderUrl}`)).status, 403);
  await fs.unlink(entry);
  await fs.writeFile(entry, text);

  // Even an exact valid old grant does not keep a formerly approved project in
  // scope after the session is reassigned elsewhere.
  store.createProject({ id: 'p_old_grant', name: 'Old scope fixture', path: outside });
  store.updateSession('s_changed', { project_id: 'p_old_grant' });
  const oldMeta = await (await getFile('s_changed', secret)).json();
  assert.ok(oldMeta.renderUrl);
  store.updateSession('s_changed', { project_id: 'p_grants' });
  assert.equal(hasApprovedRenderedEntry('s_changed', secret), true);
  assert.equal((await getFile('s_changed', secret)).status, 403, 'mention evidence cannot bypass current scope');
  assert.equal((await fetch(`${base}/${oldMeta.renderUrl}`)).status, 403);

  // Only a registered, intact relocation may equate the persisted logical name
  // with a physical mount path. No real mount or live configuration is touched.
  const mount = join(fixture, 'mounts', 'spark'), source = join(data, 'session-artifacts');
  const target = join(mount, 'artifacts');
  await fs.mkdir(mount, { recursive: true });
  await fs.rename(source, target);
  await fs.symlink(target, source);
  await fs.writeFile(process.env.AIOS_LIVE_STORAGE_CONFIG, JSON.stringify({ version: 1, id: 'grant-fixture', mount,
    mappings: [{ source, target, active: true }] }));
  const physical = join(target, 's_granted', 'dashboard.html');
  const before = openedLogs.length;
  assert.equal(hasApprovedRenderedEntry('s_granted', physical), true);
  assert.equal(hasApprovedRenderedEntry('s_neighbor', physical), false);
  for (const path of [entry, physical]) {
    const response = await getFile('s_granted', path);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).renderUrl, rendered.renderUrl, 'logical grant remains stable across migration');
  }
  assert.equal(await (await fetch(`${base}/${rendered.renderUrl}`)).text(), text);
  assert.equal(openedLogs.length, before, 'registered physical aliases also avoid history lookup');
  await fs.unlink(source);
  await fs.symlink(outside, source);
  assert.throws(() => hasApprovedRenderedEntry('s_granted', physical), error => error.code === 'storage-unavailable',
    'a replaced registered alias cannot reuse a physical entry grant');
  console.log(JSON.stringify({ handler: 'real /file and /render HTTP routes', exactGrant: 'pass', historyReads: 0,
    crossSession: 'denied', neighbor: 'denied', symlinkEscape: 'denied', staleScope: 'denied',
    registeredRelocation: 'pass', replacedAlias: 'denied', liveDataTouched: false }));
} finally {
  if (originalOpen) { fs.open = originalOpen; syncBuiltinESMExports(); }
  store?.db.close();
  await fs.rm(fixture, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
}
process.exit(0);
