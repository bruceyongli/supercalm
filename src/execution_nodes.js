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
import { mirrorExecutionSnapshot, exportExecutionState, exportExecutionProjectState } from './execution_state.js';
import { workerAuthorized, prepareWorkerImport, receiveWorkerPart, finalizeWorkerImport, activateWorkerImport, workerImportStatus, reuseWorkerGit } from './execution_worker.js';
import { gitEvidence, gitBundle, workingArchive, committedArchive, uploadExecutionPart, assertNativeIdentity } from './execution_bundle.js';
import { codexRolloutFiles, pickRolloutByUuid } from './codex_rollouts.js';
import { findClaudeLog, claudeResumeId } from './claude_transcripts.js';
import { sampleHostResources } from './resource_usage.js';
import { currentDiskCapacity } from './disk_pressure.js';
import { sessionStatusPayload } from './session_projection.js';
import { routeForModel } from './model_catalog.js';
import { callProxyModel } from './agents/model.js';
import { branchFor } from './worktrees.js';
import { executionSource, archivedGitEvidence, archivedWorkingArchive, retainedNativeRoots, executionArtifactArchives } from './execution_archive.js';
import { portableWorkingArchive, portableArtifactArchive } from './execution_tree.js';
import { planColdWorkingFiles, validateColdBuildPaths } from './execution_cold.js';
import { routeColdExecutionPreview } from './execution_cold_preview.js';
import { buildDependencyRebuildPolicy } from './execution_dependency_policy.js';
import { parseExecutionPane } from './execution_pane.js';

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
    historyOnly: !!detail.spec?.historyOnly,
    rebuildDependencies: !!detail.rebuildDependencies,
    retainHistoricalArtifacts: !!detail.retainHistoricalArtifacts,
    bytes: Object.values(detail.parts || {}).reduce((sum, p) => sum + (p.size || 0), 0) };
}

async function assertStoppedForMove(s, options = {}) {
  if (!s || remoteSession(s) || !['exited','error'].includes(s.status) || s.desired_status !== 'exited'
      || s.runtime_status !== 'exited' || s.execution_dormant) throw migrationError('Stop the session before moving it; running conversations are not interrupted');
  const { sessionBusyForCleanup } = await import('./sessions.js');
  if (sessionBusyForCleanup(s.id)) throw migrationError('Session lifecycle is busy');
  const project = store.getProject(s.project_id);
  if (!project) throw migrationError('Session project is unavailable');
  const source = await executionSource(s, project, options);
  const path = source.archive ? s.worktree_path : source.path;
  const protectedPath = await realpath(join(homedir(), 'proxy')).catch(() => resolve(homedir(), 'proxy'));
  const projectPath = await realpath(project.path);
  if (projectPath === protectedPath || projectPath.startsWith(protectedPath + '/') || path === protectedPath || path?.startsWith(protectedPath + '/')) throw migrationError('The shared proxy project cannot be moved');
  for (const other of store.listSessions()) {
    if (other.id === s.id || remoteSession(other)) continue;
    if (other.parent_session_id === s.id && !['exited','error'].includes(other.status)) throw migrationError('This session has a running helper');
    if (['starting','working','waiting'].includes(other.desired_status) &&
      (other.worktree_path === s.worktree_path && s.worktree_path || !other.worktree_path && other.project_id === s.project_id && !s.worktree_path)) throw migrationError('Another session is using this checkout');
  }
  let pane;
  try {
    // A session target can exist while display-message has no selected pane and
    // returns "|". Enumerate that exact session and require one live owned pane.
    await exec(TMUX, ['has-session', '-t', '=' + s.tmux], { timeout: 5000 });
    pane = parseExecutionPane((await exec(TMUX, ['list-panes', '-s', '-t', '=' + s.tmux, '-F',
      '#{session_name}|#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_dead}'], { timeout: 5000 })).stdout, s.tmux);
  }
  catch (error) {
    if (error.code !== 1 || !/can't find|no server running|No such file or directory/i.test(error.stderr || '')) throw migrationError('Cannot verify source terminal ownership');
  }
  if (pane) {
    const { pid, command } = pane;
    if (!['zsh','bash','sh','fish'].includes(command)) throw migrationError('The native agent is still running; use Stop before migration');
    const processes = (await exec('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 5000 })).stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    if (processes.some(([, parent]) => parent === Number(pid))) throw migrationError('The stopped terminal still has background work');
    // Retire only this proven idle shell, never an agent/process family.
    await exec(TMUX, ['kill-session', '-t', '=' + s.tmux], { timeout: 5000 });
  }
  // Detached writers need not be children of the old tmux shell. Check open
  // file descriptors/cwds once (not a recursive lsof directory walk on Spark).
  const { stdout } = await exec('/usr/sbin/lsof', ['-nP', '-Fpan'], { timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
  let owner = null, access = null;
  const ownedPaths = [path, ...(options.extraRoots || [])].filter(Boolean);
  for (const line of stdout.split('\n')) {
    if (line[0] === 'p') { owner = Number(line.slice(1)); access = null; }
    else if (line[0] === 'a') access = line.slice(1);
    else if (line[0] === 'n' && owner !== process.pid && (access === 'w' || access === 'u')
      && ownedPaths.some(root => line.slice(1) === root || line.slice(1).startsWith(root + '/'))) throw migrationError('A process still has this checkout or its session dependencies open for writing');
  }
  return { project, ...source };
}
async function nativeSource(s) {
  if (s.tool === 'codex') {
    if (!s.codex_uuid) throw migrationError('This session has no bound Codex conversation ID', 'execution-native-missing');
    let path = pickRolloutByUuid(await codexRolloutFiles(), s.codex_uuid);
    if (!path) for (const root of await retainedNativeRoots(join(homedir(), '.codex/sessions'))) {
      path = pickRolloutByUuid(await codexRolloutFiles(root), s.codex_uuid); if (path) break;
    }
    if (!path) throw migrationError('The exact Codex conversation file is unavailable', 'execution-native-missing');
    await assertNativeIdentity(path, s.tool, s.codex_uuid);
    return { path, name: basename(path), uuid: s.codex_uuid };
  }
  if (s.tool !== 'claude') throw migrationError('This tool supports history preservation only on this device', 'execution-native-missing');
  const path = await findClaudeLog(null, s, { allowHeuristic: false });
  const uuid = claudeResumeId(path);
  if (!uuid) throw migrationError('The exact Claude conversation file is unavailable', 'execution-native-missing');
  await assertNativeIdentity(path, s.tool, uuid);
  return { path, uuid };
}
async function optionalUpload(node, op, name, path, isDirectory, parts, archiveOptions = {}) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (info.isSymbolicLink()) path = await realpath(path);
  parts[name] = await uploadExecutionPart(node, op, name, isDirectory ? portableArtifactArchive(path, archiveOptions) : path);
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
    const resumingCopy = !!spec;
    const moveOptions = { history: !!detail.preserveHistory };
    if (row.kind === 'move') await assertStoppedForMove(s, moveOptions);
    if (spec && row.kind === 'move' && !spec.migrationVersion) {
      // Upgrade this exact pre-release transfer, not a replacement operation.
      // Keep its captured identity/history and add previously omitted metadata.
      const current = exportExecutionState(s.id);
      spec = { ...spec, migrationVersion: 1, tables: { ...current.tables, ...spec.tables },
        projectTables: { ...current.projectTables, ...spec.projectTables }, artifactArchives: await executionArtifactArchives(s.id) };
    }
    if (!spec && row.kind === 'move') {
      const source = await assertStoppedForMove(s, moveOptions);
      const native = await nativeSource(s).catch(error => { if (moveOptions.history && error.code === 'execution-native-missing') return null; throw error; });
      if (native && !source.path) throw migrationError('Native conversation exists but its checkout is missing; the historical move has not replaced it');
      const coldFiles = detail.rebuildDependencies && source.path && !source.archive ? await planColdWorkingFiles(source.path, detail) : null;
      const git = source.archive ? await archivedGitEvidence(source.archive, source.path) : source.path ? await gitEvidence(source.path, { excludedPaths: coldFiles?.entries.map(e => e.path) || [] }) : null;
      const gitSeedSession = store.db.prepare('SELECT id FROM sessions WHERE project_id=? AND execution_node=? AND execution_checkout=1 AND id!=? ORDER BY last_activity DESC LIMIT 1').get(s.project_id, node.id, s.id)?.id;
      spec = { ...exportExecutionState(s.id), kind: 'move', migrationVersion: 1, native, git, gitSeedSession, coldFiles,
        workingStatusHash: coldFiles ? git.statusHash : null, archive: source.archive || null, historyOnly: !native,
        artifactArchives: await executionArtifactArchives(s.id), manifest: await readManifest(s.id), artifactsPath: join(DATA_DIR, 'session-artifacts', s.id), sourcePath: source.path };
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
      spec = { session: { ...s, branch: git.branch }, project, tables: { messages: store.messagesFor(s.id, 1000) }, projectTables: exportExecutionProjectState(project.id),
        kind: 'launch', git, sourcePath, artifactsPath: join(DATA_DIR, 'session-artifacts', s.id) };
    }
    // An older failed operation may predate the first successful project import.
    // Keep its exact snapshot, but allow it to use the now-available local seed.
    if (row.kind === 'move' && spec.git?.head && !spec.gitSeedSession) {
      const seed = store.db.prepare('SELECT id FROM sessions WHERE project_id=? AND execution_node=? AND execution_checkout=1 AND id!=? ORDER BY last_activity DESC LIMIT 1').get(s.project_id, node.id, s.id);
      if (seed) spec = { ...spec, gitSeedSession: seed.id };
    }
    if (row.kind === 'move' && detail.rebuildDependencies && spec.git?.head && !spec.dependencyRebuildPolicy) {
      // Add this opt-in policy once, including exact failed-operation retries.
      // Completed moves still retain the old source roots in their snapshots.
      const sessions = store.db.prepare('SELECT id,project_id,worktree_path FROM sessions WHERE project_id=?').all(s.project_id);
      const operations = store.db.prepare(`SELECT o.session_id,o.kind,o.detail FROM execution_operations o
        JOIN sessions s ON s.id=o.session_id WHERE s.project_id=? AND o.kind='move'`).all(s.project_id);
      spec = { ...spec, dependencyRebuildPolicy: buildDependencyRebuildPolicy(spec,
        { project: store.getProject(s.project_id), sessions, operations }) };
    }
    const checkSource = async () => {
      if (!spec.git) return;
      const current = spec.archive ? await archivedGitEvidence(spec.archive, spec.sourcePath) : await gitEvidence(spec.sourcePath, { excludedPaths: spec.coldFiles?.entries.map(e => e.path) || [] });
      if (current.head !== spec.git.head || current.statusHash !== (spec.workingStatusHash || spec.git.statusHash) || spec.archive &&
        (current.indexReceipt.sha256 !== spec.git.indexReceipt.sha256 || current.archiveFingerprint !== spec.git.archiveFingerprint)) throw migrationError('The source changed since this transfer started; originals are retained');
    };
    if (row.kind === 'move' && resumingCopy) {
      await checkSource();
    }
    const parts = detail.parts || {};
    const artifactVersion = detail.retainHistoricalArtifacts ? 3 : detail.rebuildDependencies ? 2 : 0;
    if (artifactVersion > (spec.artifactCopyPolicy?.version || 0)) {
      spec = { ...spec, artifactCopyPolicy: { version: artifactVersion, rebuildDependencies: !!detail.rebuildDependencies,
        ...(detail.retainHistoricalArtifacts ? { retainHistoricalArtifacts: true, attachmentsSource: join(spec.project.path, '.aios/attachments', s.id) } : {}),
        source: spec.artifactsPath, originalsRetained: true } };
      for (const part of Object.keys(parts)) if (part === 'artifacts' || artifactVersion === 3 && (part === 'attachments' || /^artifact-\d+$/.test(part))) delete parts[part];
    }
    if (row.kind === 'move' && detail.rebuildDependencies && !spec.coldFiles && spec.sourcePath && !spec.archive) {
      const coldFiles = await planColdWorkingFiles(spec.sourcePath, detail);
      const working = await gitEvidence(spec.sourcePath, { excludedPaths: coldFiles.entries.map(e => e.path) });
      spec = { ...spec, coldFiles, workingStatusHash: working.statusHash };
      delete parts.tree; // only this operation's staged archive; Git/history receipts remain
    }
    let portableTree;
    if (spec.coldFiles) {
      portableTree = await portableWorkingArchive(spec.sourcePath, s.id, spec.coldFiles);
      spec.coldFiles.dependencies = portableTree.links.filter(l => l.rebuild).map(l => ({ name: l.name, source: l.path, localLink: l.localLink, retained: true }));
    }
    updateOperation(op, 'copying', { spec, parts });
    let status = await nodeRequest(node, `/api/execution/import/${op}`);
    if (['absent', 'receiving', 'unpacking'].includes(status.phase)) status = await nodeRequest(node, `/api/execution/import/${op}/prepare`, { method: 'POST', body: spec, timeout: 30000 });
    if (status.phase === 'active') throw migrationError('Destination is already active but ownership is not committed');
    if (status.phase === 'receiving') {
    const uploaded = part => parts[part] && status.parts?.[part]?.sha256 === parts[part].sha256;
    if (spec.git?.index && !uploaded('index')) await optionalUpload(node, op, 'index', spec.git.index, false, parts);
    if (spec.gitSeedSession && spec.git?.head && !uploaded('git')) {
      const reused = await nodeRequest(node, `/api/execution/import/${op}/git-seed`, { method: 'POST', body: {}, timeout: 10 * 60_000 });
      if (reused.receipt) { parts.git = reused.receipt; status.parts ||= {}; status.parts.git = reused.receipt; }
    }
    if (spec.git?.head && !uploaded('git')) parts.git = await uploadExecutionPart(node, op, 'git', gitBundle(spec.sourcePath, spec.git));
    updateOperation(op, 'copying', { parts });
    const tree = spec.archive ? archivedWorkingArchive(spec.archive)
      : !spec.sourcePath ? { command: '/usr/bin/tar', args: ['-cf', '-', '-T', '/dev/null'] }
      : row.kind === 'launch' && spec.git?.head ? committedArchive(spec.sourcePath, spec.git.head) : portableTree || await portableWorkingArchive(spec.sourcePath, s.id);
    if (tree.links?.length) { moveOptions.extraRoots = tree.links.map(l => l.path); await assertStoppedForMove(s, moveOptions); }
    if (!uploaded('tree')) parts.tree = await uploadExecutionPart(node, op, 'tree', tree);
    updateOperation(op, 'copying', { parts });
    if (row.kind === 'move') {
      if (spec.native && !uploaded('native')) parts.native = await uploadExecutionPart(node, op, 'native', spec.native.path);
      updateOperation(op, 'copying', { parts });
      if (s.tool === 'claude' && spec.native && !uploaded('native-extra')) await optionalUpload(node, op, 'native-extra', spec.native.path.replace(/\.jsonl$/, ''), true, parts);
      if (!uploaded('artifacts')) await optionalUpload(node, op, 'artifacts', spec.artifactsPath, true, parts, spec.artifactCopyPolicy);
      for (const [index, archive] of (spec.artifactArchives || []).entries()) {
        const part = `artifact-${index}`;
        if (!uploaded(part)) parts[part] = await uploadExecutionPart(node, op, part, archivedWorkingArchive(archive, spec.artifactCopyPolicy));
        updateOperation(op, 'copying', { parts });
      }
      if (!uploaded('attachments')) await optionalUpload(node, op, 'attachments', join(spec.project.path, '.aios/attachments', s.id), true, parts, spec.artifactCopyPolicy);
      if (!uploaded('log')) await optionalUpload(node, op, 'log', join(LOG_DIR, s.id + '.log'), false, parts);
      await assertStoppedForMove(store.getSession(s.id), moveOptions);
      await checkSource();
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
      updateOperation(op, 'activating', { destination: result.cwd, artifactTarget: result.artifactTarget, attachmentTarget: result.attachmentTarget });
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
route('POST', '/api/project/:id/execution-device', handle(async (req, { id }) => {
  const body = await readJson(req), node = executionNode(body.device), project = store.getProject(id);
  if (!project) throw migrationError('No such project', 'project-missing', 404);
  if (store.db.prepare('SELECT 1 FROM sessions WHERE project_id=? AND COALESCE(execution_node,\'local\')!=? LIMIT 1').get(id, node.id)) throw migrationError('Move every project session before changing its default execution device');
  const snapshot = await nodeRequest(node, '/api/execution/state', { timeout: 10000 });
  const destination = snapshot.projects.find(p => p.id === id && p.execution_node === node.id);
  if (!destination) throw migrationError('The project has no local checkout on that device');
  // Retain the original path/release contract as provenance; new launches resolve
  // the same project ID on its owner rather than rereading Spark on the controller.
  store.db.prepare('UPDATE projects SET execution_node=? WHERE id=?').run(node.id, id);
  bus.emit('changed');
  return { project: store.getProject(id), destination: destination.path };
}));
route('POST', '/api/session/:id/move', handle(async (req, { id: sid }) => {
  assertExecutionAvailable(sid);
  const body = await readJson(req), node = executionNode(body.device);
  const coldBuildPaths = validateColdBuildPaths(body.coldBuildPaths);
  if (coldBuildPaths.length && body.rebuildDependencies !== true) throw migrationError('Cold build paths require explicit dependency rebuilding');
  if (!['codex','claude'].includes(store.getSession(sid)?.tool) && body.preserveHistory !== true) throw migrationError('Only Codex and Claude conversations can resume on this device; older tools may be explicitly preserved as history');
  await assertStoppedForMove(store.getSession(sid), { history: body.preserveHistory === true });
  await nodeRequest(node, '/api/execution/health');
  const op = 'x_' + randomBytes(12).toString('hex'), at = Date.now();
  store.db.prepare('INSERT INTO execution_operations VALUES(?,?,?,?,?,?,?,?,?)').run(op, sid, node.id, 'move', 'queued', JSON.stringify({ preserveHistory: body.preserveHistory === true,
    rebuildDependencies: body.rebuildDependencies === true, retainHistoricalArtifacts: body.retainHistoricalArtifacts === true, coldBuildPaths }), null, at, at);
  setImmediate(() => runOperation(op));
  return { operation: publicOperation(operation(op)) };
}));
route('GET', '/api/session/:id/move', handle((_req, { id: sid }) => ({ operation: publicOperation(store.db.prepare('SELECT * FROM execution_operations WHERE session_id=? ORDER BY created_at DESC LIMIT 1').get(sid)) })));
route('POST', '/api/execution/operations/:id/retry', handle(async (req, { id }) => {
  const row = operation(id);
  if (!row || !['activating','failed'].includes(row.phase)) throw migrationError('This operation is not awaiting retry');
  const body = await readJson(req), patch = {};
  if (body.rebuildDependencies === true && !JSON.parse(row.detail).rebuildDependencies) {
    const current = await nodeRequest(executionNode(row.node), `/api/execution/import/${id}`);
    if (row.kind !== 'move' || !['absent','receiving'].includes(current.phase)) throw migrationError('This handoff has already imported files; its copy policy cannot change');
    patch.rebuildDependencies = true; patch.coldBuildPaths = validateColdBuildPaths(body.coldBuildPaths);
  }
  if (body.retainHistoricalArtifacts === true && !JSON.parse(row.detail).retainHistoricalArtifacts) {
    const current = await nodeRequest(executionNode(row.node), `/api/execution/import/${id}`);
    if (row.kind !== 'move' || !['absent','receiving'].includes(current.phase)) throw migrationError('This handoff has already imported files; its copy policy cannot change');
    patch.retainHistoricalArtifacts = true;
  }
  if (row.phase === 'failed') updateOperation(id, 'queued', patch, null);
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
route('POST', '/api/execution/import/:id/git-seed', workerOnly((_req, { id }) => reuseWorkerGit(id)));
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
  try {
    if (await routeColdExecutionPreview(req, url, sid)) return false;
    node = nodeForSession(sid);
  }
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
