// Worker half of the handoff protocol. All files are staged on its LOCAL SSD.
// Import is dormant until the controller has durably committed the owner.
import { open, mkdir, readFile, writeFile, rename, copyFile, lstat, realpath, rm, statfs } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, timingSafeEqual } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { DATA_DIR, VERSION, COMMIT_SHA } from './config.js';
import * as store from './store.js';
import { EXECUTION_NODE, migrationError } from './execution_identity.js';
import { validateArchive, assertLocalCheckout, gitEvidence, hashFile, assertNativeIdentity, gitBundle } from './execution_bundle.js';
import { importExecutionState } from './execution_state.js';
import { writeManifest } from './launch_contract.js';
import { claudeSlug } from './claude_transcripts.js';

const exec = promisify(execFile);
export const workerRoot = () => process.env.AIOS_EXECUTION_ROOT || join(homedir(), '.local/share/supercalm-executor');
const parts = new Set(['git', 'tree', 'index', 'native', 'native-extra', 'artifacts', 'attachments', 'log']);
const artifactNumber = part => /^artifact-\d+$/.test(part) ? Number(part.slice(9)) : -1;
const validPart = (row, part) => parts.has(part) || !!row.spec.artifactArchives?.[artifactNumber(part)];
function importDir(op) {
  if (!/^x_[a-f0-9]{24}$/.test(op || '')) throw migrationError('Invalid handoff operation');
  return join(workerRoot(), 'imports', op);
}
export async function workerAuthorized(req) {
  if (EXECUTION_NODE === 'local') return false;
  const token = await readFile(join(workerRoot(), 'control-token'), 'utf8');
  const given = String(req.headers['x-aios-node-token'] || '');
  return /^[a-f0-9]{64}$/.test(given) && given.length === token.trim().length
    && timingSafeEqual(Buffer.from(given), Buffer.from(token.trim()));
}
async function record(op) { return JSON.parse(await readFile(join(importDir(op), 'record.json'), 'utf8')); }
async function save(op, row) {
  const file = join(importDir(op), 'record.json');
  await writeFile(file + '.tmp', JSON.stringify(row) + '\n', { mode: 0o600 });
  await rename(file + '.tmp', file);
}
export async function prepareWorkerImport(op, spec) {
  if (!/^s_[a-zA-Z0-9_-]+$/.test(spec.session?.id || '') || !/^p_[a-zA-Z0-9_-]+$/.test(spec.project?.id || '')
    || !(spec.historyOnly === true && spec.kind === 'move' || ['claude', 'codex'].includes(spec.session?.tool)) || !['launch','move'].includes(spec.kind)) throw migrationError('Invalid session import');
  if (spec.historyOnly && spec.native) throw migrationError('A historical import cannot discard a native conversation');
  if (spec.artifactArchives && (!Array.isArray(spec.artifactArchives) || spec.artifactArchives.length > 1000 ||
    spec.artifactArchives.some(a => a.sessionId !== spec.session.id || !a.name || a.name.startsWith('.') || basename(a.name) !== a.name || /[\\\r\n\0]/.test(a.name)))) throw migrationError('Invalid archived artifact scope');
  const root = await realpath(workerRoot());
  if ((await lstat(root)).dev !== (await lstat(homedir())).dev) throw migrationError('Worker storage is not on its local SSD');
  const capacity = await statfs(root);
  if (capacity.bavail * capacity.bsize < 10 * 1024 ** 3) throw migrationError('The device has less than 10 GiB free', 'disk-space-critical', 507);
  const existing = await record(op).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (existing) {
    if (existing.spec.session.id !== spec.session.id) throw migrationError('Handoff identity conflict');
    return { phase: existing.phase, cwd: existing.cwd };
  }
  if (store.getSession(spec.session.id)) throw migrationError('Session already exists on the destination');
  const cwd = join(root, 'workspaces', spec.session.id);
  try { await lstat(cwd); throw migrationError('Destination checkout already exists; it has not been overwritten'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(importDir(op), { recursive: true, mode: 0o700 });
  const row = { phase: 'receiving', spec, cwd, parts: {}, createdAt: Date.now() };
  await save(op, row);
  return { phase: row.phase, cwd };
}
const receiving = new Set();
export async function receiveWorkerPart(op, part, request) {
  if (!validPart(await record(op), part)) throw migrationError('Unknown handoff part');
  const key = `${op}:${part}`;
  if (receiving.has(key)) throw migrationError('This handoff part is still being received');
  receiving.add(key);
  let file;
  try {
    const row = await record(op);
    if (row.phase !== 'receiving') throw migrationError('Handoff no longer accepts files');
    const path = join(importDir(op), part);
    file = await open(path + '.partial', 'w', 0o600);
    const hash = createHash('sha256'); let size = 0, checked = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size - checked >= 64 * 1024 * 1024 || !checked) {
        const disk = await statfs(workerRoot()); checked = size;
        if (disk.bavail * disk.bsize < 10 * 1024 ** 3) throw migrationError('Device storage reserve reached; source files are unchanged', 'disk-space-critical', 507);
      }
      hash.update(chunk); await file.writeFile(chunk);
    }
    await file.sync(); await file.close(); file = null;
    await rename(path + '.partial', path);
    const receipt = { size, sha256: hash.digest('hex') };
    const latest = await record(op);
    latest.parts[part] = receipt;
    await save(op, latest);
    return receipt;
  } finally { await file?.close(); receiving.delete(key); }
}
// Later sessions in one project move can reuse already-received Git objects on
// the destination SSD. This is an independent bundle, never alternates/hardlinks.
const gitReuses = new Map();
export function reuseWorkerGit(op) {
  if (!gitReuses.has(op)) gitReuses.set(op, reuseGit(op).finally(() => gitReuses.delete(op)));
  return gitReuses.get(op);
}
async function reuseGit(op) {
  const row = await record(op), sid = row.spec.gitSeedSession;
  if (row.parts.git) return { receipt: row.parts.git };
  if (row.phase !== 'receiving' || !sid || !row.spec.git?.head) return { receipt: null };
  const seed = store.getSession(sid);
  if (!seed || seed.project_id !== row.spec.session.project_id || seed.execution_node !== EXECUTION_NODE || seed.execution_dormant || !seed.execution_checkout) return { receipt: null };
  const cwd = await assertLocalCheckout(seed.worktree_path);
  const index = row.parts.index ? join(importDir(op), 'index') : null;
  // A missing staged object means use the real source, not silently drop it.
  try {
    await exec('/usr/bin/git', ['-C', cwd, 'cat-file', '-e', row.spec.git.head], { timeout: 10000 });
    if (index) {
      const staged = (await exec('/usr/bin/git', ['-C', cwd, 'ls-files', '--stage', '-z'], { timeout: 30000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0' } })).stdout;
      const known = new Set((await exec('/usr/bin/git', ['-C', cwd, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)'], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 })).stdout.split('\n'));
      if (staged.split('\0').filter(Boolean).some(line => !known.has(line.split(' ')[1]))) return { receipt: null };
    }
  } catch { return { receipt: null }; }
  const descriptor = gitBundle(cwd, { head: row.spec.git.head, index: index || undefined });
  const path = join(importDir(op), 'git');
  const child = spawn(descriptor.command, descriptor.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(migrationError('Local Git seed export failed; source retained'))); });
  try { await Promise.all([done, pipeline(child.stdout, createWriteStream(path + '.partial', { mode: 0o600 }))]); }
  catch (error) { child.kill('SIGTERM'); throw error; }
  await rename(path + '.partial', path);
  const receipt = await hashFile(path);
  const latest = await record(op); latest.parts.git = receipt; latest.gitSeedSession = sid; await save(op, latest);
  return { receipt };
}
async function unpack(op, part, destination) {
  const file = join(importDir(op), part);
  await validateArchive(file, { allowGit: part !== 'tree' });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await exec('/usr/bin/tar', ['-xf', file, '-C', destination, '--no-same-owner'], { timeout: 30 * 60_000, maxBuffer: 65536 });
}
async function copyIdentical(source, destination) {
  try { await copyFile(source, destination, 1); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const [a, b] = await Promise.all([hashFile(source), hashFile(destination)]);
    if (a.sha256 !== b.sha256 || a.size !== b.size) throw migrationError('Existing destination file differs; it was not overwritten');
  }
}
const finalizations = new Map();
export function finalizeWorkerImport(op, expected) {
  if (!finalizations.has(op)) finalizations.set(op, finalizeImport(op, expected).finally(() => finalizations.delete(op)));
  return finalizations.get(op);
}
async function finalizeImport(op, expected) {
  if ([...receiving].some(key => key.startsWith(op + ':'))) throw migrationError('Transfer is still receiving files');
  let row = await record(op);
  if (['imported','active'].includes(row.phase)) return { cwd: row.cwd, mapping: row.mapping, phase: row.phase };
  if (!['receiving','unpacking','files-ready'].includes(row.phase)) throw migrationError('Incomplete handoff needs recovery; originals are retained');
  for (const [part, receipt] of Object.entries(expected.parts || {})) {
    if (!row.parts[part] || row.parts[part].size !== receipt.size || row.parts[part].sha256 !== receipt.sha256) throw migrationError('Transfer receipt mismatch');
  }
  const spec = row.spec;
  if (!row.parts.tree || spec.git?.head && !row.parts.git || spec.kind === 'move' && !spec.historyOnly && !row.parts.native) throw migrationError('Handoff is missing required files');
  if ((spec.artifactArchives || []).some((a, i) => !row.parts[`artifact-${i}`])) throw migrationError('Handoff is missing archived artifacts');
  if (spec.git?.indexReceipt && (row.parts.index?.sha256 !== spec.git.indexReceipt.sha256 || row.parts.index.size !== spec.git.indexReceipt.size)) throw migrationError('The archived index differs from its source receipt');
  const cwd = row.cwd;
  const filesReady = row.phase === 'files-ready';
  let transcript = row.transcript || null;
  if (!filesReady) {
  row.phase = 'unpacking'; await save(op, row);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const git = async args => exec('/usr/bin/git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', ...args], {
    timeout: 10 * 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
  });
  if (!spec.historyOnly || spec.git?.head) await git(['init', '-b', spec.git?.branch || 'main']);
  if (spec.git?.head) {
    // This is our dormant import directory, never a user's live checkout. Include
    // detached HEAD objects as well as refs before restoring the copied index.
    await git(['fetch', '--update-head-ok', '--no-write-fetch-head', join(importDir(op), 'git'), 'HEAD', '+refs/*:refs/*']);
    await git(['update-ref', 'HEAD', spec.git.head]);
    await git(['read-tree', spec.git.head]);
  }
  if (spec.git?.origin) await git(['remote', 'add', 'origin', spec.git.origin]).catch(() => git(['remote', 'set-url', 'origin', spec.git.origin]));
  // Copy author identity only, never credential helpers, hooks or global config.
  for (const [key, value] of Object.entries(spec.git?.identity || {})) {
    if (['name','email'].includes(key) && typeof value === 'string' && value && value.length <= 512 && !/[\r\n\0]/.test(value)) {
      await git(['config', '--local', `user.${key}`, value]);
    }
  }
  await unpack(op, 'tree', cwd);
  if (await lstat(join(cwd, '.aios/execution-dependencies')).then(s => s.isDirectory(), e => { if (e.code === 'ENOENT') return false; throw e; })) {
    // This namespace was absent at source and is created only by the portable
    // exporter. Do not add dependency copies to the user's Git working changes.
    await writeFile(join(cwd, '.git/info/exclude'), '\n/.aios/execution-dependencies/\n', { flag: 'a' });
  }
  if (row.parts.index) await copyFile(join(importDir(op), 'index'), join(cwd, '.git/index'));
  if (!spec.historyOnly || spec.git?.head) await assertLocalCheckout(cwd);
  if (spec.git?.head) {
    const observed = await gitEvidence(cwd);
    if (observed.head !== spec.git.head || spec.kind === 'move' && !spec.archive && observed.statusHash !== spec.git.statusHash) {
      throw migrationError('The destination Git state differs; the source is still authoritative');
    }
  }
  if (row.parts.native) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(spec.native?.uuid || '')) throw migrationError('Exact native conversation ID is required');
    const date = String(spec.native.name || '').match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
    if (spec.session.tool === 'codex' && (!date || !spec.native.name.endsWith(`-${spec.native.uuid}.jsonl`) || basename(spec.native.name) !== spec.native.name)) throw migrationError('Invalid Codex rollout identity');
    await assertNativeIdentity(join(importDir(op), 'native'), spec.session.tool, spec.native.uuid);
    const base = spec.session.tool === 'claude' ? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', claudeSlug(cwd))
      : join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions', ...date.slice(1));
    await mkdir(base, { recursive: true, mode: 0o700 });
    transcript = join(base, spec.session.tool === 'claude' ? spec.native.uuid + '.jsonl' : spec.native.name);
    await copyIdentical(join(importDir(op), 'native'), transcript);
    if (row.parts['native-extra']) await unpack(op, 'native-extra', join(base, spec.native.uuid));
  }
  if (row.parts.artifacts) await unpack(op, 'artifacts', join(DATA_DIR, 'session-artifacts', spec.session.id));
  for (const [index, archive] of (spec.artifactArchives || []).entries()) {
    await unpack(op, `artifact-${index}`, join(DATA_DIR, 'session-artifacts', spec.session.id, archive.name));
  }
  if (row.parts.attachments) await unpack(op, 'attachments', join(cwd, '.aios/attachments', spec.session.id));
  if (row.parts.log) await copyIdentical(join(importDir(op), 'log'), join(DATA_DIR, 'logs', spec.session.id + '.log'));
  row.phase = 'files-ready'; row.transcript = transcript; await save(op, row);
  }
  const projectPath = store.getProject(spec.project.id)?.path || cwd;
  const mapping = importExecutionState(spec, { cwd, projectPath, transcript: spec.session.tool === 'claude' ? transcript : null, operation: op, kind: spec.kind });
  // Native AIOS child sessions, when explicitly requested, remain isolated on this Mac.
  const { setHelpers } = await import('./project_helpers.js');
  setHelpers(spec.project.id, { isolation: true });
  await writeManifest(spec.session.id, { ...spec.manifest, tool: spec.session.tool, project_path: projectPath,
    cwd, worktree_path: cwd, branch: spec.git?.branch || null, autonomy: spec.session.autonomy,
    model: spec.session.model, effort: spec.session.effort, execution_operation: op,
    previous_locations: [{ project: spec.project.path, worktree: spec.session.worktree_path, artifacts: spec.artifactsPath,
      target: cwd, artifactTarget: join(DATA_DIR, 'session-artifacts', spec.session.id) }] });
  row = { ...row, phase: 'imported', mapping, importedAt: Date.now() };
  await save(op, row);
  return { cwd, mapping, phase: 'imported' };
}
const activations = new Map();
export function activateWorkerImport(op) {
  if (!activations.has(op)) activations.set(op, activateImport(op).finally(() => activations.delete(op)));
  return activations.get(op);
}
async function activateImport(op) {
  const row = await record(op);
  if (!['imported','active'].includes(row.phase)) throw migrationError('Handoff is not ready');
  const sid = row.spec.session.id;
  store.db.prepare('UPDATE sessions SET execution_dormant=0,revision=revision+2 WHERE id=? AND execution_dormant=1').run(sid);
  // A move keeps the session paused. Only a fresh launch runs automatically.
  row.phase = 'active'; await save(op, row);
  if (row.spec.kind === 'launch' && store.getSession(sid)?.status_reason === 'execution-staged') {
    const { launchPreparedSession } = await import('./sessions.js');
    await launchPreparedSession(sid);
  }
  // Transfer containers are duplicates, not originals. Keep the small receipt/journal;
  // no full archive or dependency cache remains beside the final local working set.
  for (const part of Object.keys(row.parts)) if (validPart(row, part)) await rm(join(importDir(op), part), { force: true });
  return { session: store.getSession(sid), phase: 'active' };
}
export async function workerImportStatus(op) {
  const row = await record(op).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!row) return { phase: 'absent' };
  return { phase: row.phase, cwd: row.cwd, mapping: row.mapping || [], parts: row.parts,
    session: store.getSession(row.spec.session.id) || null };
}
