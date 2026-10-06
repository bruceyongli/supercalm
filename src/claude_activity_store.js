import { db } from './store.js';

const lastInput = db.prepare("SELECT MAX(ts) ts FROM messages WHERE session_id=? AND direction='in'");
const lastIntent = db.prepare(`SELECT MAX(ts) ts FROM events WHERE session_id=? AND (
  type IN ('launch','resume','input','usage-limit-stop','stop-request','kill-request')
  OR (type='hook' AND json_valid(payload) AND json_extract(payload,'$.tool')='claude'
    AND json_extract(payload,'$.event') IN ('UserPromptSubmit','Stop','StopFailure','PermissionRequest',
      'Elicitation','ElicitationResult','PreCompact','PostCompact','SubagentStart','SubagentStop'))
)`);

// One-time hydration of legacy poll-corrupted clocks. Keep all real operator/agent intent, exclude
// boot adoption, maintenance and idle notifications. No report/read/dismissal/history is deleted.
export function claudeDurableActivityAt(id, nativeAt) {
  return Math.max(Number(nativeAt) || 0, Number(lastInput.get(id)?.ts) || 0, Number(lastIntent.get(id)?.ts) || 0);
}
