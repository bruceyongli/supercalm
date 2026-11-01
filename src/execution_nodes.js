import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { route, json, readJson, setExecutionRouter } from './server.js';
import { DATA_DIR, LOG_DIR, TMUX, VERSION, COMMIT_SHA } from './config.js';
import * as store from './store.js';
import { bus } from './bus.js';
import { withSessionArchiveLock } from './archive_lock.js';
import { readManifest } from './launch_contract.js';
import { EXECUTION_NODE, remoteSession, migrationError } from './execution_identity.js';
import { loadExecutionNodes, executionNodes, executionNode, nodeRequest, connectExecutionNode, proxyNodeRequest } from './execution_transport.js';
import { nodeForSession, executionDeviceList, assertExecutionAvailable } from './execution_routing.js';
import { mirrorExecutionSnapshot, exportExecutionState } from './execution_state.js';
import { workerAuthorized, prepareWorkerImport, receiveWorkerPart, finalizeWorkerImport, activateWorkerImport, workerImportStatus } from './execution_worker.js';
import { gitEvidence, gitBundle, workingArchive, committedArchive, uploadExecutionPart, assertNativeIdentity } from './execution_bundle.js';
import { codexRolloutFiles, pickRolloutByUuid } from './codex_rollouts.js';
import { findClaudeLog, claudeResumeId } from './claude_transcripts.js';
import { sampleHostResources } from './resource_usage.js';
import { currentDiskCapacity } from './disk_pressure.js';
import { sessionStatusPayload } from './session_projection.js';
import { routeForModel } from './model_catalog.js';
import { callProxyModel } from './agents/model.js';
import { branchFor } from './worktrees.js';

const exec = promisify(execFile), flights = new Map(), syncFlights = new Map();
const operation = id => store.db.prepare('SELECT * FROM execution_operations WHERE id=?').get(id);
function updateOperation(id, phase, patch = {}, error = null) {
  const old = operation(id);
  if (old.phase === 'cancelled') throw migrationError('Transfer was stopped by the operator', 'execution-cancelled');
  const detail = { ...JSON.parse(old.detail), ...patch };
  store.db.prepare('UPDATE execution_operations SET phase=?,detail=?,error=?,updated_at=? WHERE id=?')
    .run(phase, JSON.stringify(detail), error, Date.now(), id);
  bus.emit('event', { type: 'execution-transfer', session: old.session_id, operation: id, phase, error });
  return { ...old, phase, detail, error };
}
function publicOperation(row) {
  if (!row) return null;
  const detail = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;
  return { id: row.id, session_id: row.session_id, node: row.node, kind: row.kind, phase: row.phase,
    error: row.error, created_at: row.created_at, updated_at: row.updated_at,
    bytes: Object.values(detail.parts || {}).reduce((sum, p) => sum + (p.size || 0), 0) };
}

async function assertStoppedForMove(s) {
  if (!s || remoteSession(s) || !['exited','error'].includes(s.status) || s.desired_status !== 'exited'
      || s.runtime_status !== 'exited' || s.execution_dormant) throw migrationError('Stop the session before moving it; running conversations are not interrupted');
  const { sessionBusyForCleanup } = await import('./sessions.js');
  if (sessionBusyForCleanup(s.id)) throw migrationError('Session lifecycle is busy');
  const project = store.getProject(s.project_id);
  if (!project) throw migrationError('Session project is unavailable');
  const path = await realpath(s.worktree_path || project.path);
  const protectedPath = await realpath(join(homedir(), 'proxy')).catch(() => resolve(homedir(), 'proxy'));
  if (path === protectedPath || path.startsWith(protectedPath + '/')) throw migrationError('The shared proxy project cannot be moved');
  for (const other of store.listSessions()) {
    if (other.id === s.id || remoteSession(other)) continue;
    if (other.parent_session_id === s.id && !['exited','error'].includes(other.status)) throw migrationError('This session has a running helper');
    if (['starting','working','waiting'].includes(other.desired_status) &&
      (other.worktree_path === s.worktree_path && s.worktree_path || !other.worktree_path && other.project_id === s.project_id && !s.worktree_path)) throw migrationError('Another session is using this checkout');
  }
  let pane;
  try {
    // tmux display-message can return an empty format with exit 0 for a missing
    // target. Prove exact presence first; never infer it from formatted output.
    await exec(TMUX, ['has-session', '-t', '=' + s.tmux], { timeout: 5000 });
    pane = (await exec(TMUX, ['display-message', '-p', '-t', '=' + s.tmux, '#{pane_pid}|#{pane_current_command}'], { timeout: 5000 })).stdout.trim();
    if (!/^\d+\|.+/.test(pane)) throw migrationError('Source terminal identity is unavailable');
  }
  catch (error) {
    if (error.code !== 1 || !/can't find|no server running|No such file or directory/i.test(error.stderr || '')) throw migrationError('Cannot verify source terminal ownership');
  }
  if (pane) {
    const [pid, command] = pane.split('|');
    if (!['zsh','bash','sh','fish'].includes(command)) throw migrationError('The native agent is still running; use Stop before migration');
    const processes = (await exec('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 5000 })).stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    if (processes.some(([, parent]) => parent === Number(pid))) throw migrationError('The stopped terminal still has background work');
    // Retire only this proven idle shell, never an agent/process family.
    await exec(TMUX, ['kill-session', '-t', s.tmux], { timeout: 5000 });
  }
  // Detached writers need not be children of the old tmux shell. Check open
  // file descriptors/cwds once (not a recursive lsof directory walk on Spark).
  const { stdout } = await exec('/usr/sbin/lsof', ['-nP', '-Fpan'], { timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
  let owner = null, access = null;
  for (const line of stdout.split('\n')) {
    if (line[0] === 'p') { owner = Number(line.slice(1)); access = null; }
    else if (line[0] === 'a') access = line.slice(1);
    else if (line[0] === 'n' && owner !== process.pid && (access === 'w' || access === 'u')
      && (line.slice(1) === path || line.slice(1).startsWith(path + '/'))) throw migrationError('A process still has this checkout open for writing');
  }
  return { project, path };
}
async function nativeSource(s) {
  if (s.tool === 'codex') {
    if (!s.codex_uuid) throw migrationError('This session has no bound Codex conversation ID');
    const path = pickRolloutByUuid(await codexRolloutFiles(), s.codex_uuid);
    if (!path) throw migrationError('The exact Codex conversation file is unavailable');
    await assertNativeIdentity(path, s.tool, s.codex_uuid);
    return { path, name: basename(path), uuid: s.codex_uuid };
  }
  const path = await findClaudeLog(null, s, { allowHeuristic: false });
  const uuid = claudeResumeId(path);
  if (!uuid) throw migrationError('The exact Claude conversation file is unavailable');
  await assertNativeIdentity(path, s.tool, uuid);
  return { path, uuid };
}
async function optionalUpload(node, op, name, path, isDirectory, parts) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (info.isSymbolicLink()) path = await realpath(path);
  parts[name] = await uploadExecutionPart(node, op, name, isDirectory ? workingArchive(path) : path);
  updateOperation(op, 'copying', { parts });
}
async function performOperation(op) {
  let row = operation(op), detail = JSON.parse(row.detail);
  const node = executionNode(row.node);
  // Ownership has already committed: never copy/re-import or roll back this generation.
  if (row.phase === 'activating') {
    await nodeRequest(node, `/api/execution/import/${op}/activate`, { method: 'POST', body: {}, timeout: 60000 });
    updateOperation(op, 'complete'); await syncNode(node); return;
  }
  await withSessionArchiveLock(row.session_id, async () => {
    let s = store.getSession(row.session_id), spec = detail.spec;
    if (row.kind === 'move') await assertStoppedForMove(s);
    if (!spec && row.kind === 'move') {
      const source = await assertStoppedForMove(s);
      const native = await nativeSource(s);
      spec = { ...exportExecutionState(s.id), kind: 'move', native, git: await gitEvidence(source.path),
        manifest: await readManifest(s.id), artifactsPath: join(DATA_DIR, 'session-artifacts', s.id), sourcePath: source.path };
    } else if (!spec) {
      const project = store.getProject(s.project_id);
      const sourcePath = await realpath(project.path);
      let git;
      try { git = await gitEvidence(sourcePath); }
      catch (error) {
        const head = await exec('/usr/bin/git', ['-C', sourcePath, 'rev-parse', '--verify', 'HEAD'], { timeout: 10000 }).then(() => true, e => e.code === 128 ? false : Promise.reject(e));
        if (head) throw error;
        git = { head: null, branch: 'main', origin: null };
      }
      git.branch = branchFor(project, s.id);
      spec = { session: { ...s, branch: git.branch }, project, tables: { messages: store.messagesFor(s.id, 1000) }, projectTables: {},
        kind: 'launch', git, sourcePath, artifactsPath: join(DATA_DIR, 'session-artifacts', s.id) };
    }
    if (row.kind === 'move') {
      const current = await gitEvidence(spec.sourcePath);
      if (current.head !== spec.git.head || current.statusHash !== spec.git.statusHash) throw migrationError('The source changed since this transfer started; originals are retained');
    }
    const parts = detail.parts || {};
    updateOperation(op, 'copying', { spec, parts });
    let status = await nodeRequest(node, `/api/execution/import/${op}`);
    if (status.phase === 'absent') status = await nodeRequest(node, `/api/execution/import/${op}/prepare`, { method: 'POST', body: spec, timeout: 30000 });
    if (status.phase === 'active') throw migrationError('Destination is already active but ownership is not committed');
    if (status.phase === 'receiving') {
    const uploaded = part => parts[part] && status.parts?.[part]?.sha256 === parts[part].sha256;
    if (spec.git.head && !uploaded('git')) parts.git = await uploadExecutionPart(node, op, 'git', gitBundle(spec.sourcePath));
    updateOperation(op, 'copying', { parts });
    if (!uploaded('tree')) parts.tree = await uploadExecutionPart(node, op, 'tree', row.kind === 'launch' && spec.git.head
      ? committedArchive(spec.sourcePath, spec.git.head) : workingArchive(spec.sourcePath));
    updateOperation(op, 'copying', { parts });
    if (row.kind === 'move') {
      if (spec.git.index) await optionalUpload(node, op, 'index', spec.git.index, false, parts);
      parts.native = await uploadExecutionPart(node, op, 'native', spec.native.path);
      updateOperation(op, 'copying', { parts });
      if (s.tool === 'claude') await optionalUpload(node, op, 'native-extra', spec.native.path.replace(/\.jsonl$/, ''), true, parts);
      await optionalUpload(node, op, 'artifacts', spec.artifactsPath, true, parts);
      await optionalUpload(node, op, 'attachments', join(spec.project.path, '.aios/attachments', s.id), true, parts);
      await optionalUpload(node, op, 'log', join(LOG_DIR, s.id + '.log'), false, parts);
      await assertStoppedForMove(store.getSession(s.id));
      const after = await gitEvidence(spec.sourcePath);
      if (after.head !== spec.git.head || after.statusHash !== spec.git.statusHash) throw migrationError('Source checkout changed during transfer. Source ownership is unchanged.');
    }
    }
    updateOperation(op, 'importing', { parts });
    const result = await nodeRequest(node, `/api/execution/import/${op}/finalize`, { method: 'POST', body: { parts }, timeout: 30 * 60_000 });
    if (operation(op).phase === 'cancelled') throw migrationError('Transfer stopped before ownership changed', 'execution-cancelled');
    // One SQLite transaction is the handoff point. A crash before it keeps the source
    // authoritative; a crash after it can only activate this exact destination import.
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.db.prepare('UPDATE sessions SET execution_node=?,worktree_path=?,execution_revision=NULL,revision=revision+1 WHERE id=?')
        .run(node.id, result.cwd, s.id);
      for (const m of result.mapping || []) store.db.prepare('INSERT OR IGNORE INTO execution_message_map(node,remote_id,local_id) VALUES(?,?,?)').run(node.id, m.remote_id, m.local_id);
      updateOperation(op, 'activating', { destination: result.cwd });
      store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    await nodeRequest(node, `/api/execution/import/${op}/activate`, { method: 'POST', body: {}, timeout: 60000 });
    updateOperation(op, 'complete');
    await syncNode(node);
  });
}
function runOperation(op) {
  if (flights.has(op)) return flights.get(op);
  const promise = performOperation(op).catch(error => {
    const row = operation(op);
    if (row.phase === 'cancelled') return;
    // Ownership-committed failures remain retryable at this exact operation, never restored locally.
    const phase = row.phase === 'activating' ? 'activating' : 'failed';
    updateOperation(op, phase, {}, String(error.message || error).slice(0, 800));
    if (row.kind === 'launch' && phase === 'failed') store.updateSession(row.session_id, {
      status: 'error', desired_status: 'exited', runtime_status: 'exited', status_reason: 'execution-launch-failed', summary: String(error.message || error).slice(0, 500) });
    console.error('[aios] execution handoff', op, phase, error.code || 'failed');
  }).finally(() => flights.delete(op));
  flights.set(op, promise); return promise;
}
export async function queueExecutionLaunch(nodeId, args) {
  const node = executionNode(nodeId);
  if (!['codex','claude'].includes(args.tool)) throw migrationError('This device supports Codex and Claude Code', 'execution-tool', 400);
  const ready = await nodeRequest(node, '/api/execution/health');
  if (ready.node !== node.id || ready.protocol !== 1) throw migrationError('Execution device identity mismatch');
  if (args.project.execution_node && args.project.execution_node !== EXECUTION_NODE) {
    if (args.project.execution_node !== node.id) throw migrationError('Choose this project’s owning execution device');
    const result = await nodeRequest(node, '/api/session', { method: 'POST', body: {
      project_id: args.project.id, tool: args.tool, task: args.task, model: args.model, effort: args.effort,
      autonomy: args.autonomy, fast_mode: args.fastMode, orchestration: args.orchestration,
      parent_session_id: args.parentSessionId, agent_name: args.agentName }, timeout: 30000 });
    await syncNode(node); return store.getSession(result.id) || result;
  }
  const sid = 's_' + randomBytes(5).toString('hex');
  const session = store.createSession({ id: sid, project_id: args.project.id, tool: args.tool,
    tmux: `aios-node-${sid}`, title: String(args.task || '(interactive)').slice(0, 100),
    status: 'starting', autonomy: args.autonomy, effort: args.effort, model: args.model,
    fast_mode: args.fastMode ? 1 : 0, orchestration: args.orchestration, parent_session_id: args.parentSessionId });
  // Fence local recovery immediately; the worker import is still dormant.
  store.updateSession(sid, { execution_node: node.id, status_reason: 'execution-copying' });
  if (args.task) store.addMessage(sid, 'in', 'task', args.task);
  const op = 'x_' + randomBytes(12).toString('hex'), at = Date.now();
  store.db.prepare('INSERT INTO execution_operations VALUES(?,?,?,?,?,?,?,?,?)')
    .run(op, sid, node.id, 'launch', 'queued', '{}', null, at, at);
  bus.emit('changed');
  setImmediate(() => runOperation(op));
  return { ...store.getSession(sid), execution_operation: op };
}
async function syncNode(node) {
  if (syncFlights.has(node.id)) return syncFlights.get(node.id);
  const run = (async () => {
    try {
      const cursor = store.db.prepare('SELECT cursor FROM execution_sync WHERE node=?').get(node.id)?.cursor || 0;
      const data = await nodeRequest(node, `/api/execution/state?after=${cursor}`, { timeout: 5000 });
      mirrorExecutionSnapshot(node, data);
    } catch (error) {
      store.db.prepare(`INSERT INTO execution_sync(node,online,error,checked_at) VALUES(?,0,?,?)
        ON CONFLICT(node) DO UPDATE SET online=0,error=excluded.error,checked_at=excluded.checked_at`)
        .run(node.id, error.code === 'execution-device-offline' ? 'Device offline — sessions remain on that device' : 'Device synchronization failed', Date.now());
    }
  })().finally(() => syncFlights.delete(node.id));
  syncFlights.set(node.id, run); return run;
}

const handle = fn => async (req, res, params, url) => {
  try { json(res, 200, await fn(req, params, url)); }
  catch (error) { json(res, error.status || 503, { error: error.message, code: error.code || 'execution-unavailable' }); }
};
const workerOnly = fn => handle(async (req, params, url) => {
  if (!await workerAuthorized(req)) throw migrationError('Worker control authentication required', 'execution-auth', 403);
  return fn(req, params, url);
});
route('GET', '/api/execution/devices', handle(() => ({ devices: executionDeviceList(),
  operations: store.db.prepare('SELECT * FROM execution_operations ORDER BY created_at DESC LIMIT 30').all().map(publicOperation) })));
route('POST', '/api/session/:id/move', handle(async (req, { id: sid }) => {
  assertExecutionAvailable(sid);
  const body = await readJson(req), node = executionNode(body.device);
  if (!['codex','claude'].includes(store.getSession(sid)?.tool)) throw migrationError('Only Codex and Claude conversations can move to this device');
  await assertStoppedForMove(store.getSession(sid));
  await nodeRequest(node, '/api/execution/health');
  const op = 'x_' + randomBytes(12).toString('hex'), at = Date.now();
  store.db.prepare('INSERT INTO execution_operations VALUES(?,?,?,?,?,?,?,?,?)').run(op, sid, node.id, 'move', 'queued', '{}', null, at, at);
  setImmediate(() => runOperation(op));
  return { operation: publicOperation(operation(op)) };
}));
route('GET', '/api/session/:id/move', handle((_req, { id: sid }) => ({ operation: publicOperation(store.db.prepare('SELECT * FROM execution_operations WHERE session_id=? ORDER BY created_at DESC LIMIT 1').get(sid)) })));
route('POST', '/api/execution/operations/:id/retry', handle(async (_req, { id }) => {
  const row = operation(id);
  if (!row || !['activating','failed'].includes(row.phase)) throw migrationError('This operation is not awaiting retry');
  if (row.phase === 'failed') updateOperation(id, 'queued', {}, null);
  runOperation(id); return { operation: publicOperation(row) };
}));
route('GET', '/api/execution/health', workerOnly(async () => ({ protocol: 1, node: EXECUTION_NODE, version: VERSION,
  commit: COMMIT_SHA, disk: currentDiskCapacity(), host: await sampleHostResources() })));
route('GET', '/api/execution/state', workerOnly(async (_req, _params, url) => {
  const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
  const messages = store.db.prepare('SELECT m.* FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id>? AND s.execution_dormant=0 ORDER BY m.id LIMIT 1000').all(after);
  return { protocol: 1, node: EXECUTION_NODE, version: VERSION, projects: store.listProjects(),
    sessions: store.listLocalSessions().filter(s => !s.execution_dormant), messages,
    cursor: messages.at(-1)?.id || after, health: { disk: currentDiskCapacity(), host: sampleHostResources.peek(), version: VERSION } };
}));
route('POST', '/api/execution/import/:id/prepare', workerOnly(async (req, { id }) => prepareWorkerImport(id, await readJson(req))));
route('PUT', '/api/execution/import/:id/:part', workerOnly((req, { id, part }) => receiveWorkerPart(id, part, req)));
route('POST', '/api/execution/import/:id/finalize', workerOnly(async (req, { id }) => finalizeWorkerImport(id, await readJson(req))));
route('POST', '/api/execution/import/:id/activate', workerOnly((_req, { id }) => activateWorkerImport(id)));
route('GET', '/api/execution/import/:id', workerOnly((_req, { id }) => workerImportStatus(id)));
route('GET', '/api/session/:id/execution/snapshot', workerOnly(async (_req, { id }, url) => ({ snapshot: await import('./sessions.js').then(m => m.snapshot(id, Math.min(10000, Number(url.searchParams.get('lines')) || 0))) })));
route('POST', '/api/session/:id/execution/evidence', workerOnly(async (req, { id }) => {
  const body = await readJson(req);
  return import('./voice.js').then(m => m.voiceEvidenceFor({ ...body, sessionId: id }, { refresh: true }));
}));
route('POST', '/api/session/:id/execution/reply', workerOnly(async (req, { id }) => {
  const body = await readJson(req);
  return import('./sessions.js').then(m => m.deliverReply(id, String(body.text || ''), body.options || {}));
}));
route('POST', '/api/session/:id/execution/text', workerOnly(async (req, { id }) => {
  const body = await readJson(req), session = store.getSession(id);
  if (!session) throw migrationError('No such session', 'session-missing', 404);
  return import('./sessions.js').then(m => m.sendText(session.tmux, String(body.text || ''), body.options || {}));
}));
route('POST', '/api/session/:id/execution/resume', workerOnly(async (req, { id }) => {
  const options = await readJson(req);
  return import('./sessions.js').then(m => m.resume(id, options));
}));
route('POST', '/api/execution/model', handle(async req => {
  const node = executionNodes().find(n => n.id === req.headers['x-aios-node-id']);
  if (!node || req.headers['x-aios-node-token'] !== node.token) throw migrationError('Worker authentication required', 'execution-auth', 403);
  const body = await readJson(req);
  const result = await callProxyModel(routeForModel(body.model), body.messages, body.options || {});
  return result;
}));
setExecutionRouter(async (req, res, url) => {
  const match = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(.*))?$/);
  // Detail/history IDs belong to the controller's shared attention ledger. Native
  // Story, terminal, files and actions stay on the owning device.
  if (!match || match[2] === 'move' || !match[2] && req.method === 'GET') return false;
  const sid = decodeURIComponent(match[1]);
  const transfer = store.db.prepare("SELECT * FROM execution_operations WHERE session_id=? AND phase NOT IN ('complete','failed','cancelled') ORDER BY created_at DESC LIMIT 1").get(sid);
  // Stop always wins before ownership commits. The receiving copy may finish its
  // current stream, but the cancellation fence prevents import/activation.
  if (req.method === 'POST' && ['stop','kill'].includes(match[2]) && transfer && transfer.phase !== 'activating') {
    store.db.prepare("UPDATE execution_operations SET phase='cancelled',updated_at=? WHERE id=?").run(Date.now(), transfer.id);
    if (transfer.kind === 'launch') store.updateSession(sid, { status: 'exited', desired_status: 'exited', runtime_status: 'exited', status_reason: 'operator-stop' });
    json(res, 200, { ok: true, cancelled: true, session: store.getSession(sid) });
    bus.emit('changed'); return true;
  }
  if (!['GET','HEAD'].includes(req.method)) {
    try { assertExecutionAvailable(sid); }
    catch (error) { json(res, error.status, { error: error.message, code: error.code }); return true; }
  }
  let node;
  try { node = nodeForSession(sid); }
  catch (error) { json(res, error.status || 503, { error: error.message, code: error.code }); return true; }
  if (!node) return false;
  await proxyNodeRequest(node, req, res, url.pathname + url.search); return true;
});

await loadExecutionNodes();
if (EXECUTION_NODE === 'local') {
  const poll = () => { for (const node of executionNodes()) {
    connectExecutionNode(node);
    syncNode(node).then(() => {
      if (!store.db.prepare('SELECT online FROM execution_sync WHERE node=?').get(node.id)?.online) return;
      for (const row of store.db.prepare("SELECT id FROM execution_operations WHERE node=? AND phase NOT IN ('complete','failed','cancelled')").all(node.id)) runOperation(row.id);
    });
  } };
  poll(); setInterval(poll, 5000).unref();
}
