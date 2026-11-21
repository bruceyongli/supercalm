// Only the controller's gated, fixed release installer prepares a target.
// The same proof is privately consumed for automatic setup or explicitly pasted
// for manual pairing; credentials, shell commands and paths are not web inputs.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withFileLease } from './archive_lock.js';
import { executionId, migrationError } from './execution_identity.js';
import { assertNewDevice, executionRegistryFile, loadExecutionNodes, saveExecutionNode, validateExecutionNode } from './execution_transport.js';

const dir = join(dirname(executionRegistryFile), 'execution-pairings');
const TTL = 15 * 60_000;
const digest = code => createHash('sha256').update(code).digest();
const record = id => join(dir, executionId(id) + '.json');
const lease = (id, fn) => withFileLease(record(id) + '.lock', () => migrationError('Device setup is in progress. Retry when it finishes.'), fn);
const invalid = () => migrationError('That pairing code is invalid, expired, or already used. Check the device list or run the setup command again.', 'invalid-pairing-code', 400);
async function read(id) {
  try { return JSON.parse(await readFile(record(id), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function write(id, value) {
  const path = record(id), tmp = path + '.' + randomBytes(6).toString('hex');
  await writeFile(tmp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  await rename(tmp, path);
}
export function checkPairingTarget(id, host) {
  executionId(id);
  if (typeof host !== 'string' || host.length > 200 || !/^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*@)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host)
    || /^(localhost(?:\.|$)|127\.|0\.0\.0\.0$)/i.test(host.split('@').at(-1))) {
    throw migrationError('Enter a remote SSH alias or user@hostname.', 'invalid-device-host', 400);
  }
}
// install must check ownership before modifying the Mac, and authenticate the
// installed worker's ID and commit before returning its local SSD root.
export async function preparePairing({ id, host, commit }, install) {
  checkPairingTarget(id, host);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('A published release is required');
  return lease(id, async () => {
    assertNewDevice(await loadExecutionNodes(), { id, host });
    const previous = await read(id);
    if (previous && previous.host !== host) throw migrationError('This ID has an unfinished setup for another SSH host. Use its original ID and host, or choose another ID.');
    const token = previous?.token || randomBytes(32).toString('hex');
    const pending = { id, host, commit, token };
    await write(id, pending); // keep ownership across interrupted downloads/installs
    const spec = { id, host, token, label: id, local: false, default: false, localPort: 18893, remotePort: 8794, callbackPort: 18793 };
    const node = validateExecutionNode({ ...spec, root: await install(spec) });
    const code = id + '.' + randomBytes(16).toString('hex');
    await write(id, { ...pending, node, hash: digest(code).toString('hex'), expires: Date.now() + TTL });
    return code;
  });
}
export async function claimPairing(code, runningCommit) {
  if (typeof code !== 'string' || !/^[a-z][a-z0-9_-]{0,39}\.[a-f0-9]{32}$/.test(code)) throw invalid();
  const id = code.split('.')[0];
  const valid = row => row?.hash && row.expires > Date.now() && timingSafeEqual(digest(code), Buffer.from(row.hash, 'hex'));
  if (id === 'local' || !valid(await read(id))) throw invalid(); // unknown codes don't create lock files
  return lease(id, async () => {
    const row = await read(id);
    if (!valid(row)) throw invalid();
    if (row.commit !== runningCommit) throw migrationError('The controller was updated. Run the setup command again to pair this release.', 'pairing-release-changed');
    const node = await saveExecutionNode(row.node, { addOnly: true });
    await unlink(record(id)); // registry is already durable; a stale record can never overwrite it
    return { id: node.id, label: node.label };
  });
}
