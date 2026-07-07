// Offline measurement: replay recent supervisor interventions from the LIVE db against the branch's
// engagement policy — what would the attention governor have gated?
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { tierOf, allowedWhenTier, askTtlMs } = await import(join(ROOT, 'src/agents/supervisor/engagement.js'));
const db = new DatabaseSync(process.env.AIOS_DB || join(process.env.HOME, 'aios/data/aios.db'), { readOnly: true });
const H48 = Date.now() - 48 * 3600 * 1000;

const touches = new Map(); // session -> sorted operator-touch ts asc
for (const r of db.prepare("SELECT session_id, ts FROM messages WHERE direction='in' AND source IN ('text','voice','text+attachments') ORDER BY ts").all()) {
  if (!touches.has(r.session_id)) touches.set(r.session_id, []);
  touches.get(r.session_id).push(Number(r.ts));
}
const started = new Map(db.prepare('SELECT id, started_at FROM sessions').all().map((r) => [r.id, Number(r.started_at) || 0]));
function tierAt(sid, ts) {
  const arr = touches.get(sid) || [];
  let last = started.get(sid) || 0;
  for (const t of arr) { if (t <= ts) last = Math.max(last, t); else break; }
  return tierOf({ lastTouch: last, now: ts });
}
const KIND2GATE = { verify: 'verify', gate: 'verify', keepworking: 'nudge', unstick: 'nudge', checkpoint: 'nudge', answer: 'answer', escalate: 'answer', 'doc-update': 'doc', recover: 'recover' };
const rows = db.prepare('SELECT session_id, ts, kind, COALESCE(repeat,1) reps FROM supervisor_reviews WHERE ts > ?').all(H48);
const tot = { calls: 0, gated: 0, byKind: {}, gatedByKind: {} };
for (const r of rows) {
  const gateKind = KIND2GATE[r.kind]; if (!gateKind) continue;
  const reps = Math.max(1, Number(r.reps));
  tot.calls += reps; tot.byKind[r.kind] = (tot.byKind[r.kind] || 0) + reps;
  const tier = tierAt(r.session_id, Number(r.ts));
  // conservative: warm 'verify' counts only the FIRST call per row as allowed (new-work), reps beyond gated
  let gated = 0;
  if (!allowedWhenTier(tier, gateKind, { newWork: true })) gated = reps;
  else if (tier === 'warm' && gateKind === 'verify') gated = reps - 1;
  tot.gated += gated; if (gated) tot.gatedByKind[r.kind] = (tot.gatedByKind[r.kind] || 0) + gated;
}
console.log('window: last 48h · supervisor model-call-bearing interventions');
console.log('total est calls:', tot.calls, '| would be GATED by governor:', tot.gated, `(${Math.round((tot.gated / Math.max(1, tot.calls)) * 100)}%)`);
console.log('by kind (total):', JSON.stringify(tot.byKind));
console.log('gated by kind :', JSON.stringify(tot.gatedByKind));
// queue + hygiene now
const sess = db.prepare("SELECT id, status, category, started_at FROM sessions WHERE status='waiting' AND COALESCE(category,'')!='working'").all();
const q = sess.map((s) => ({ id: s.id, tier: tierAt(s.id, Date.now()) }));
console.log('queue now:', q.length, 'items →', JSON.stringify({ live: q.filter((x) => x.tier !== 'stale').length, stale: q.filter((x) => x.tier === 'stale').length }));
const leaked = db.prepare("SELECT COUNT(*) n FROM decisions WHERE status='pending' AND asked_at < ?").get(Date.now() - askTtlMs()).n;
console.log('pending asks past TTL (would expire):', leaked);
const zomb = db.prepare("SELECT COUNT(*) n FROM agent_grants g JOIN sessions s ON s.id=g.session_id WHERE g.agent_id='supervisor' AND g.enabled=1 AND s.status='exited'").get().n;
console.log('zombie supervisor grants (exited sessions):', zomb);
