// Narrow, auditable repair for the old resume path that stamped reboot time onto idle sessions.
// Keep all messages, read/dismissal state and runtime state. Never rewind activity after recovery.
import { nativeWorkActivity } from './session_recovery_activity.js';

const meaningful = `(type IN ('launch','input','terminal-input','stop','kill','stop-request','kill-request','usage-limit-stop')
  OR (type='resume' AND COALESCE(json_extract(payload,'$.reason'),'')!='boot-recovery')
  OR (type='hook' AND json_extract(payload,'$.event') IN ('UserPromptSubmit','Stop','StopFailure',
    'PermissionRequest','Elicitation','ElicitationResult','SubagentStart','SubagentStop','agent-turn-complete')))`;

export async function repairRebootRecency(db, { dryRun = false, nativeActivity = nativeWorkActivity, at = Date.now() } = {}) {
  const candidates = db.prepare(`SELECT s.*, e.id recovery_id, e.ts recovery_at, e.payload recovery_payload
    FROM sessions s JOIN events e ON e.id=(SELECT id FROM events WHERE session_id=s.id AND type='boot-recovery-start' ORDER BY ts DESC LIMIT 1)
    WHERE s.last_activity>=e.ts AND s.last_activity<=e.ts+120000
      AND json_extract(e.payload,'$.desired_status')='waiting'
      AND NOT EXISTS (SELECT 1 FROM events fixed WHERE fixed.session_id=s.id AND fixed.type='reboot-recency-repaired'
        AND json_extract(fixed.payload,'$.recovery_event_id')=e.id)`).all();
  const input = db.prepare("SELECT MAX(ts) ts FROM messages WHERE session_id=? AND direction='in'");
  const intent = db.prepare(`SELECT MAX(ts) ts FROM events WHERE session_id=? AND json_valid(payload) AND ${meaningful}`);
  const previousMessage = db.prepare('SELECT MAX(ts) ts FROM messages WHERE session_id=? AND ts<?');
  const previousEvent = db.prepare(`SELECT MAX(ts) ts FROM events WHERE session_id=? AND ts<? AND json_valid(payload)
    AND (type='status' OR ${meaningful})`);
  const update = db.prepare('UPDATE sessions SET last_activity=?, revision=revision+1 WHERE id=? AND last_activity=?');
  const audit = db.prepare("INSERT INTO events(session_id,ts,type,payload) VALUES (?,?,'reboot-recency-repaired',?)");
  const repaired = [];
  for (const session of candidates) {
    const recentInput = Number(input.get(session.id)?.ts) || 0, recentIntent = Number(intent.get(session.id)?.ts) || 0;
    if (Math.max(recentInput, recentIntent) >= session.recovery_at) continue;
    const native = await nativeActivity(session).catch(() => ({ available: true, lastAt: 0 }));
    if (native.lastAt >= session.recovery_at || native.available && !native.lastAt) continue; // uncertain evidence: leave it alone
    const checkpoint = Number(JSON.parse(session.recovery_payload).previous_last_activity) || 0;
    const actual = Math.max(checkpoint, native.lastAt || 0, recentInput, recentIntent,
      Number(previousMessage.get(session.id, session.recovery_at)?.ts) || 0,
      Number(previousEvent.get(session.id, session.recovery_at)?.ts) || 0, Number(session.started_at) || 0);
    if (!actual || actual >= session.recovery_at || actual >= session.last_activity) continue;
    const evidence = { recovery_event_id: session.recovery_id, previous: session.last_activity, actual,
      native_at: native.lastAt || null, checkpoint: checkpoint || null };
    if (dryRun) { repaired.push({ id: session.id, ...evidence }); continue; }
    db.exec('BEGIN IMMEDIATE');
    try {
      if (update.run(actual, session.id, session.last_activity).changes) {
        audit.run(session.id, at, JSON.stringify(evidence));
        repaired.push({ id: session.id, ...evidence });
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return repaired;
}
