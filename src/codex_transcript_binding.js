// Shared launch-time / Story-time recovery of an exact Codex transcript. This never changes agent
// lifecycle or attention state and never guesses from a same-project file's size or recency.
import * as store from './store.js';
import { bus } from './bus.js';
import { sessionStatusPayload } from './session_projection.js';
import { findCodexLaunchRollout, rolloutUuidFromName } from './codex_rollouts.js';

const latestLaunch = store.db.prepare("SELECT id, ts, payload FROM events WHERE session_id=? AND type='launch' ORDER BY id DESC LIMIT 1");
const owners = store.db.prepare('SELECT id, codex_uuid FROM sessions WHERE codex_uuid IS NOT NULL');
const flights = new Map();

export async function bindCodexLaunchTranscript(sid, { files, beforeSet } = {}) {
  if (flights.has(sid)) return flights.get(sid);
  const flight = recover(sid, files, beforeSet).finally(() => flights.delete(sid));
  flights.set(sid, flight);
  return flight;
}

async function recover(sid, files, beforeSet) {
  const s = store.getSession(sid);
  if (!s || s.tool !== 'codex' || s.codex_uuid) return null;
  const launch = latestLaunch.get(sid);
  if (!launch) return null;
  let payload;
  try { payload = JSON.parse(launch.payload); } catch { return null; }
  const claimed = new Set(owners.all().filter(row => row.id !== sid).map(row => row.codex_uuid));
  const file = await findCodexLaunchRollout(beforeSet ? files.filter(f => !beforeSet.has(f)) : files, {
    cwd: payload.dir, startedAt: launch.ts, task: payload.task, claimed, allowEmptyTask: !!beforeSet,
  });
  if (!file) return null;
  const uuid = rolloutUuidFromName(file);
  // Recheck after asynchronous filesystem reads: another binder, resume, or session removal can
  // have won in the meantime. Never overwrite an authoritative binding or a newer launch identity.
  const current = store.getSession(sid);
  if (!current || current.codex_uuid || latestLaunch.get(sid)?.id !== launch.id
      || owners.all().some(row => row.id !== sid && row.codex_uuid === uuid)) return null;
  const updated = store.updateSession(sid, { codex_uuid: uuid });
  store.addEvent(sid, 'codex-uuid', { uuid, source: 'launch-evidence', file });
  bus.emit('session-status', sessionStatusPayload(updated, { previousStatus: current.status, source: 'transcript' }));
  return file;
}
