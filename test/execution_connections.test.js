import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, unlink, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configureExecutionConnection, connectionConfig, connectionSpec } from '../src/execution_connections.js';

const exec = promisify(execFile);
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'aios-connections-')));
async function fixture(name) {
  const home = join(scratch, name), root = join(home, '.local/share/executor');
  await mkdir(root, { recursive: true }); await mkdir(join(home, '.ssh'), { mode: 0o700 });
  const identityFile = join(home, '.ssh/id_fixture');
  await writeFile(identityFile, 'fixture-not-a-real-key', { mode: 0o600 });
  const spec = { alias: 'publish-fixture', host: '192.0.2.10', user: 'publisher', identityFile };
  return { home, root, spec };
}
const original = '# Keep this unrelated host\nServerAliveInterval 37\nHost another\n  HostName example.invalid\n  User unrelated\n';
const calls = [];
const run = async (file, args, options) => {
  calls.push(args);
  if (args[0] === '-G') return exec(file, args, options);
  assert.equal(args.at(-1), 'true', 'connection checks never run a deploy or modify remote files');
  return { stdout: '' };
};
try {
  const f = await fixture('working'), config = join(f.home, '.ssh/config');
  await writeFile(config, original, { mode: 0o644 });
  const result = await configureExecutionConnection({ ...f, run });
  assert.equal(result.privateKeysCopied, false); assert.equal(result.credentialMode, 'existing-device-key');
  assert.ok(result.verifiedAt > 0);
  const text = await readFile(config, 'utf8');
  assert.ok(text.endsWith(original)); assert.equal((await stat(config)).mode & 0o777, 0o644);
  assert.equal((await stat(join(f.root, 'connections/publish-fixture.conf'))).mode & 0o777, 0o600);
  const resolved = (await exec('/usr/bin/ssh', ['-G', '-F', config, f.spec.alias])).stdout;
  assert.match(resolved, /^hostname 192\.0\.2\.10$/m); assert.match(resolved, /^user publisher$/m);
  assert.match(resolved, /^stricthostkeychecking true$/m);
  assert.match(resolved, /^serveraliveinterval 37$/m, 'Include must not leak Host scope into pre-existing globals');
  const other = (await exec('/usr/bin/ssh', ['-G', '-F', config, 'another'])).stdout;
  assert.match(other, /^hostname example\.invalid$/m); assert.match(other, /^user unrelated$/m);
  assert.match(other, /^serveraliveinterval 37$/m);
  const preflight = calls.find(args => args.includes('publisher@192.0.2.10'));
  for (const flag of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'IdentitiesOnly=yes', 'IdentityAgent=none']) assert.ok(preflight.includes(flag));
  await configureExecutionConnection({ ...f, run });
  assert.equal(await readFile(config, 'utf8'), text, 'idempotent configuration');
  await unlink(join(f.root, 'connections/publish-fixture.json'));
  await configureExecutionConnection({ ...f, run });
  assert.equal(await readFile(config, 'utf8'), text, 'recover own partial configuration after a post-check failure');
  await assert.rejects(configureExecutionConnection({ ...f, spec: { ...f.spec, host: '192.0.2.20' }, run }), /different settings/);
  assert.equal(await readFile(f.spec.identityFile, 'utf8'), 'fixture-not-a-real-key');

  const fail = await fixture('offline');
  await writeFile(join(fail.home, '.ssh/config'), original);
  await assert.rejects(configureExecutionConnection({ ...fail, run: async (file, args, options) => {
    if (args[0] === '-G') return run(file, args, options); throw Error('connection refused');
  } }), /connection refused/);
  assert.equal(await readFile(join(fail.home, '.ssh/config'), 'utf8'), original);
  await assert.rejects(stat(join(fail.root, 'connections/publish-fixture.conf')), { code: 'ENOENT' });
  await assert.rejects(stat(join(fail.root, 'connections/.configure.lock')), { code: 'ENOENT' });

  const conflict = await fixture('conflict');
  await writeFile(join(conflict.home, '.ssh/config'), 'Host publish-fixture\n  HostName example.invalid\n');
  await assert.rejects(configureExecutionConnection({ ...conflict, run }), /outside Supercalm/);
  const before = calls.length;
  for (const name of ['publish-fixture.json', 'publish-fixture.conf']) {
    const bad = await fixture(name);
    await mkdir(join(bad.root, 'connections'), { mode: 0o700 });
    await symlink(f.spec.identityFile, join(bad.root, 'connections', name));
    await assert.rejects(configureExecutionConnection({ ...bad, run }), /regular file/);
  }
  assert.equal(calls.length, before, 'unsafe local metadata is rejected before network activity');
  const badKey = await fixture('key');
  await chmod(badKey.spec.identityFile, 0o644);
  await assert.rejects(configureExecutionConnection({ ...badKey, run }), /private/);
  await unlink(badKey.spec.identityFile); await symlink(f.spec.identityFile, badKey.spec.identityFile);
  await assert.rejects(configureExecutionConnection({ ...badKey, run }), /device’s SSH directory/);
  assert.throws(() => connectionSpec({ ...f.spec, host: 'host\nProxyCommand evil' }), /Invalid/);
  assert.throws(() => connectionConfig({ ...f.spec, identityFile: 'relative' }), /absolute/);
  console.log('execution_connections: preserved config/key, strict identity, idempotent, recovery, conflict/symlink/offline checks passed');
} finally { await rm(scratch, { recursive: true, force: true }); }
