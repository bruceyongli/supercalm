// Durable maintenance interlock, local even when project storage is disconnected. It is not
// an operator Stop: no lifecycle, activity, attention, supervisor grant or history is rewritten.
import { readFileSync, constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { DATA_DIR } from './config.js';
import { cleanAgentScreen } from './agent_input_ready.js';

function checkpointNativeId(session) {
  const value = session?.tool === 'codex' ? session.codex_uuid
    : session?.tool === 'claude' ? basename(String(session.claude_transcript || ''), '.jsonl') : null;
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value || '') ? value.toLowerCase() : null;
}

// The launch manifest is a birth record; legitimate work can switch branches.
// Snapshot the observed branch BEFORE maintenance pauses this exact conversation.
export function createStorageBranchCheckpoint(pending, branch, capturedAt = Date.now()) {
  const nativeId = checkpointNativeId(pending);
  if (!pending?.id || !pending.token || !pending.worktree_path?.startsWith('/')
      || !pending.project_path?.startsWith('/') || !nativeId || !branch || branch === 'HEAD' || /[\r\n\0]/.test(branch)) return null;
  return { version: 1, source: 'pre-freeze', capturedAt, sessionId: pending.id, token: pending.token,
    tool: pending.tool, nativeId, worktreePath: pending.worktree_path, projectPath: pending.project_path, branch };
}

// Pure, deliberately narrow exception: ONLY a branch-only launch mismatch may
// preserve the pre-maintenance branch. This is not `force`, a native-ID fallback,
// or permission to substitute another checkout. pathsEqual is supplied by the
// registered-storage mapping layer, not by untrusted report/conversation text.
export function storageBranchCheckpointAllows({ manifest, verdict, pending, session, actualBranch, actualWorktreePath,
  projectPath, maintenanceToken, recoveryReason, pathsEqual = (a, b) => a === b, now = Date.now() } = {}) {
  const checkpoint = pending?.branchCheckpoint;
  if (recoveryReason !== 'storage-maintenance' || !maintenanceToken || maintenanceToken !== pending?.token
      || !['parking', 'parked', 'resuming'].includes(pending?.phase)
      || !manifest || !verdict || verdict.ok || verdict.mismatches?.length !== 1 || !verdict.mismatches[0].startsWith('branch: ')
      || !checkpoint || checkpoint.version !== 1 || checkpoint.token !== maintenanceToken
      || !Number.isFinite(checkpoint.capturedAt) || checkpoint.capturedAt <= 0 || checkpoint.capturedAt > now
      || checkpoint.sessionId !== pending.id || pending.id !== session?.id || manifest.sid && manifest.sid !== session.id
      || !['working', 'waiting'].includes(session.desired_status) || /^operator-/.test(session.status_reason || '')
      || checkpoint.tool !== pending.tool || pending.tool !== session.tool || manifest.tool && manifest.tool !== session.tool
      || !checkpoint.nativeId || checkpoint.nativeId !== checkpointNativeId(pending) || checkpoint.nativeId !== checkpointNativeId(session)
      || !checkpoint.branch || checkpoint.branch === 'HEAD' || checkpoint.branch !== actualBranch
      || !checkpoint.worktreePath?.startsWith('/') || checkpoint.worktreePath !== pending.worktree_path || checkpoint.worktreePath !== session.worktree_path
      || manifest.worktree_path && manifest.worktree_path !== session.worktree_path
      || !actualWorktreePath || !pathsEqual(checkpoint.worktreePath, actualWorktreePath)
      || !checkpoint.projectPath?.startsWith('/') || checkpoint.projectPath !== pending.project_path || checkpoint.projectPath !== projectPath
      || manifest.project_path && !pathsEqual(manifest.project_path, projectPath)
      || manifest.cwd && !pathsEqual(manifest.cwd, actualWorktreePath)) return false;
  if (checkpoint.source === 'pre-freeze') return true;
  return checkpoint.source === 'recovered-pre-maintenance-evidence' && Array.isArray(checkpoint.evidence)
    && checkpoint.evidence.length > 0 && checkpoint.evidence.every(e => e?.path?.startsWith('/') && /^[a-f0-9]{64}$/.test(e.sha256 || ''));
}

// Manually recovered legacy checkpoints must retain their exact local evidence.
// Hash only these explicitly listed small records, never the project/worktree.
export async function storageBranchEvidenceValid(checkpoint) {
  if (checkpoint?.source === 'pre-freeze') return true;
  if (checkpoint?.source !== 'recovered-pre-maintenance-evidence' || !Array.isArray(checkpoint.evidence)
      || !checkpoint.evidence.length || checkpoint.evidence.length > 8) return false;
  try {
    for (const evidence of checkpoint.evidence) {
      if (!evidence?.path?.startsWith('/') || !/^[a-f0-9]{64}$/.test(evidence.sha256 || '')) return false;
      const handle = await open(evidence.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > 32 * 1024 * 1024) return false;
        const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024); let offset = 0;
        while (offset < before.size) {
          const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
          if (!result.bytesRead) return false;
          hash.update(buffer.subarray(0, result.bytesRead)); offset += result.bytesRead;
        }
        const after = await handle.stat();
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || hash.digest('hex') !== evidence.sha256) return false;
      } finally { await handle.close(); }
    }
    return true;
  } catch { return false; }
}

export function storageRecoveryGate(screen) {
  const tail = cleanAgentScreen(screen).trimEnd().split('\n').slice(-20).join('\n');
  if (/This conversation is open in another app/.test(tail) && /r retry\s+f fork\s+esc/.test(tail)) return 'conversation-in-use';
  if (/1\. Try new model/.test(tail) && /2\. Use existing model/.test(tail) && /enter\/esc confirm/.test(tail)) return 'model-offer';
  return null;
}

export const storageMaintenanceFile = join(DATA_DIR, 'storage-maintenance.json');
export function readStorageMaintenance(file = storageMaintenanceFile) {
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (value.version !== 1 || value.kind !== 'live-storage-migration' || !Array.isArray(value.sessions)) {
    throw Error('Invalid storage maintenance journal; refusing lifecycle changes');
  }
  return value.phase === 'complete' ? null : value;
}
export function storageMaintenanceFor(id, file = storageMaintenanceFile) {
  return readStorageMaintenance(file)?.sessions.find(s => s.id === id && s.phase !== 'complete') || null;
}
export function assertStorageSessionAvailable(id, token = null) {
  const pending = storageMaintenanceFor(id);
  if (pending && (!token || token !== pending.token)) throw storageMaintenanceError();
}
export function assertStorageLaunchAvailable() {
  if (readStorageMaintenance()?.blockLaunches) throw storageMaintenanceError();
}
export function storageMaintenanceError() {
  return Object.assign(Error('Storage migration is pausing this session. Your message is preserved; retry when migration finishes.'),
    { code: 'storage-maintenance', status: 503 });
}
