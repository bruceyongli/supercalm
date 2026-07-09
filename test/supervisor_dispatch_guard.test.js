// Executes the REAL send dispatcher against a scratch DB: the card-lifecycle choke point
// (self-echo incident, v0.3.26) must block lifecycle directives on EVERY supervisor path in every
// mode, record the distinct suppression reason, deliver nothing — and exempt only the operator
// relay (hold.resolve_send), whose text is the operator's own words. This is the execution-level
// proof on top of the pure-regex matrix in supervisor_send_policy.test.js.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.AIOS_DATA = process.env.AIOS_DATA || mkdtempSync(join(tmpdir(), 'aios-dispatch-guard-'));

const assert = (await import('node:assert/strict')).default;
const { dispatchSupervisorSend, triggeringSignal } = await import('../src/agents/supervisor/dispatch.js');
const { db } = await import('../src/store.js');

const sends = [];
const ctx = { sessionId: 's_disp_guard', sendToAgent: async (msg) => { sends.push(msg); return { sent: true, message: msg }; } };
const snapshot = {
  schema: 'supervisor.snapshot/v1',
  decisionIntent: { type: 'continue', text: 'keep going, finish it', ts: Date.now(), confidence: 0.9 },
  operator: {},
  session: {},
};
const sig = () => triggeringSignal('agent_question', 'test ask', 'test');

// The verbatim incident directive, on the answer path: blocked, nothing delivered.
const INCIDENT = 'Start the pending “Workflow Editor design + connection fixes” card as the active task. Treat the Workflow log UI redesign card as done/closed rather than merging the two goals; preserve its history, then continue on the editor card.';
{
  const r = await dispatchSupervisorSend(ctx, { snapshot, ruleId: 'answer.send', actionType: 'answer', text: INCIDENT, allowedSend: true, triggeringSignal: sig() });
  assert.equal(r.sent, false, 'incident directive must not send');
  assert.equal(r.reason, 'card-lifecycle-operator-reserved');
  assert.equal(sends.length, 0, 'nothing reached the agent');
}

// Same block on a NON-answer path (the v0.3.25 gap): a challenge-shaped lifecycle push.
{
  const r = await dispatchSupervisorSend(ctx, { snapshot, ruleId: 'gate.challenge', actionType: 'challenge', text: 'Close the current card as done and start the next one.', allowedSend: true, triggeringSignal: sig() });
  assert.equal(r.sent, false, 'lifecycle text blocked on challenge path too');
  assert.equal(r.reason, 'card-lifecycle-operator-reserved');
  assert.equal(sends.length, 0);
}

// Benign steering still flows (no false lockout of the supervisor's real job).
{
  const r = await dispatchSupervisorSend(ctx, { snapshot, ruleId: 'answer.send', actionType: 'answer', text: 'Run the failing test first, then fix the null deref in renderTaskCard and commit.', allowedSend: true, triggeringSignal: sig() });
  assert.equal(r.sent, true, 'benign answer delivers');
  assert.equal(sends.length, 1);
}

// Operator relay exemption: the operator's own words may manage cards.
{
  const r = await dispatchSupervisorSend(ctx, { snapshot, ruleId: 'hold.resolve_send', actionType: 'recover', text: 'Close the card as done, I verified it myself.', allowedSend: true, triggeringSignal: sig() });
  assert.equal(r.sent, true, 'operator relay is exempt');
  assert.equal(sends.length, 2);
}

// The blocks were RECORDED with the distinct reason (what the panel feed shows the operator).
{
  const rows = db.prepare("SELECT suppression_reason, sent FROM supervisor_decisions WHERE session_id='s_disp_guard' ORDER BY ts").all();
  assert.equal(rows.length, 4, 'every dispatch recorded a decision');
  assert.deepEqual(rows.map((r) => r.suppression_reason), ['card-lifecycle-operator-reserved', 'card-lifecycle-operator-reserved', '', '']);
  assert.deepEqual(rows.map((r) => r.sent), [0, 0, 1, 1]);
}

console.log('supervisor_dispatch_guard.test ok');
process.exit(0); // store.js may hold timers; this test owns its process
