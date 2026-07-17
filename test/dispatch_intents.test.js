import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-dispatch-intents-'));

const { dispatchSupervisorSend } = await import('../src/agents/supervisor/dispatch.js');

// A minimal ctx that captures what would hit the pane. persistDecision writes to the scratch DB.
function fakeCtx() {
  const sent = [];
  return {
    sent,
    sessionId: 's_intents',
    getState: () => ({}),
    setState: () => ({}),
    emit: () => {},
    log: () => {},
    async sendToAgent(text, opts = {}) { sent.push({ text, opts }); return { sent: true, message: text }; },
  };
}
const snapshot = {
  schema: 'supervisor.snapshot',
  generatedAt: 1782400000000,
  session: { id: 's_intents', status: 'waiting', category: 'action', summary: '', updatedAt: 1782400000000 },
  operator: { intent: 'continue', lastMessageText: 'keep going', lastMessageTs: 1782399999000, intentConfidence: 0.9 },
  decisionIntent: { type: 'continue', text: 'keep going', ts: 1782399999000, confidence: 0.9 },
  supervisorState: {},
  agent: {},
};

// ---- a typed intent renders the exact template and carries its own kernel lane ----
{
  const ctx = fakeCtx();
  const r = await dispatchSupervisorSend(ctx, {
    snapshot, ruleId: 'stuck.keep_working', actionType: 'nudge', allowedSend: true,
    intent: { name: 'CONTINUE', params: { reason: 'phase 1 slice 2 is unfinished' } },
    triggeringSignal: { type: 'stall', summary: 'no forward progress', ts: 1782400000001 },
  });
  assert.equal(r.sent, true);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].text, 'Continue: phase 1 slice 2 is unfinished');
  assert.equal(ctx.sent[0].opts.kind, 'nudge', 'the rendered intent supplies the kernel lane');
}

// ---- a render refusal is a recorded NON-send: no improvised text ever reaches the pane ----
{
  const ctx = fakeCtx();
  const r = await dispatchSupervisorSend(ctx, {
    snapshot, ruleId: 'stuck.keep_working', actionType: 'nudge', allowedSend: true,
    intent: { name: 'CONTINUE', params: { reason: 'run the tool at /path/to/model' } }, // S7 placeholder
    triggeringSignal: { type: 'stall', summary: 'no forward progress', ts: 1782400000002 },
  });
  assert.equal(r.sent, false, 'placeholder content is unrenderable');
  assert.match(r.reason, /intent-render-refused/);
  assert.equal(ctx.sent.length, 0, 'nothing reached the pane');
}

// ---- unknown intents fail closed even when the caller says allowedSend ----
{
  const ctx = fakeCtx();
  const r = await dispatchSupervisorSend(ctx, {
    snapshot, ruleId: 'x', actionType: 'nudge', allowedSend: true,
    intent: { name: 'DEPLOY_NOW', params: {} },
    triggeringSignal: { type: 'x', summary: 'x', ts: 1 },
  });
  assert.equal(r.sent, false);
  assert.match(r.reason, /intent-render-refused/);
  assert.equal(ctx.sent.length, 0);
}

// ---- free-text path still works during the strangler migration (kind from actionType) ----
{
  const ctx = fakeCtx();
  const r = await dispatchSupervisorSend(ctx, {
    snapshot, ruleId: 'answer.confident', actionType: 'answer', allowedSend: true,
    text: 'Use the existing helper module.',
    triggeringSignal: { type: 'question', summary: 'which module?', ts: 2 },
  });
  assert.equal(r.sent, true);
  assert.equal(ctx.sent[0].opts.kind, 'answer');
}

console.log('dispatch_intents: all assertions passed');
