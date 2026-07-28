import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'aios-supervisor-scrub-'));
process.env.AIOS_DATA = DATA_DIR;
process.env.AIOS_NO_LISTEN = '1';
process.on('exit', () => { try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {} });

const { scrubSupervisorText } = await import('../src/agents/supervisor/scrub.js');
const { buildVerifyAttemptsAudit } = await import('../src/agents/supervisor/verify.js');
const { __lab } = await import('../src/agents/supervisor.js');
const { db } = await import('../src/store.js');

const KEY = 'sk-supersecret1234567890';
const BEARER = 'Bearer abcdefghijklmnopqrstuvwxyz123456';
const DATA_URI = 'data:image/png;base64,ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789==';
const DIRTY = `${KEY} ${BEARER} ${DATA_URI}`;

{
  const safe = scrubSupervisorText(DIRTY);
  assert.doesNotMatch(safe, /supersecret|abcdefghijklmnopqrstuvwxyz123456|ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/);
  assert.match(safe, /\[redacted-key\]/);
  assert.match(safe, /Bearer \[redacted\]/);
  assert.match(safe, /\[redacted-data-uri\]/);
}

{
  const audit = buildVerifyAttemptsAudit({
    attempts: [{ n: 1, output: DIRTY, error: `upstream echoed ${KEY}` }],
    acceptedAttempt: 1,
    finalRawAttempt: 1,
  });
  assert.doesNotMatch(audit, /supersecret1234567890/, 'verification provenance uses the shared scrubber');
  assert.match(audit, /\[redacted-key\]/);
}

const SNAPSHOT = {
  schema: 'supervisor.snapshot/v1',
  decisionIntent: { type: 'continue', text: 'continue', ts: Date.now(), confidence: 0.9 },
  operator: {},
  session: {},
};
const CFG = {
  model: 'claude-opus-5',
  fallback_models: ['claude-opus-5'],
  mode: 'copilot',
  calibrated_escalation: true,
  decision_memory: false,
  goal_doubt: true,
  doc: '# Task\n## Goal\nHandle the request safely.\n',
};

function makeCtx({ sid, decision, question }) {
  let state = {};
  const sends = [];
  const notes = [];
  const events = [];
  return {
    sessionId: sid,
    session: () => ({
      id: sid,
      tool: 'claude',
      status: 'waiting',
      autonomy: 'full',
      category: 'decision',
      title: 'Secret handling',
      question,
      summary: question,
    }),
    project: () => null,
    getState: () => ({ ...state }),
    setState: (patch) => { state = { ...state, ...patch }; return { ...state }; },
    getConfig: () => ({}),
    setConfig: () => {},
    getEvidence: async () => ({ images: [], terminal_tail: '', recent_messages: [], git: {} }),
    visionRoute: () => false,
    callModel: async (_messages, opts = {}) => ({
      content: JSON.stringify(decision),
      model: opts.model,
      route: { model: opts.model },
      canSee: false,
    }),
    sendToAgent: async (text) => { sends.push(text); return { sent: true, message: text }; },
    runProbes: async () => [{ type: 'git', result: { ok: true, dirty: true, lastCommitAt: Date.now() - 3600_000 } }],
    hasCap: () => true,
    notifyOperator: (title, body) => notes.push({ title, body }),
    emit: (type, payload) => events.push({ type, payload }),
    log: () => {},
    _state: () => state,
    _sends: sends,
    _notes: notes,
    _events: events,
  };
}

function persistedBlob(sessionId) {
  const rows = db.prepare('SELECT assessment, message, sent_text, error, raw FROM supervisor_reviews WHERE session_id = ?').all(sessionId);
  return JSON.stringify(rows);
}

{
  const sid = 's_scrub_answer';
  const ctx = makeCtx({
    sid,
    question: `The diagnostic contains ${KEY}. What should I do?`,
    decision: {
      action: 'answer',
      answer: `Rotate ${KEY}; upstream also returned ${BEARER}.`,
      recommendation: '',
      reason_code: 'none',
      reason: `The exposed key ${KEY} must be rotated.`,
      audience: 'builder_blocked',
      confidence: 0.99,
      reserved: false,
    },
  });
  await __lab.runAnswer(ctx, CFG, { terminal_tail: '', recent_messages: [], git: {} }, 'question', 0, SNAPSHOT, 0);
  assert.equal(ctx._sends.length, 1);
  assert.doesNotMatch(JSON.stringify(ctx._sends), /supersecret1234567890|abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(ctx._sends[0], /\[redacted-key\]/);
  assert.doesNotMatch(persistedBlob(sid), /supersecret1234567890|abcdefghijklmnopqrstuvwxyz123456/);
}

{
  const sid = 's_scrub_escalation';
  const ctx = makeCtx({
    sid,
    question: `May I publish ${KEY}?`,
    decision: {
      action: 'escalate',
      answer: '',
      recommendation: `Do not publish ${KEY}; rotate it.`,
      reason_code: 'scope',
      reason: `The operator must decide how to handle ${KEY}.`,
      audience: 'operator_choice',
      confidence: 0.99,
      reserved: true,
    },
  });
  await __lab.runAnswer(ctx, CFG, { terminal_tail: '', recent_messages: [], git: {} }, 'question', 0, SNAPSHOT, 0);
  assert.equal(ctx._sends.length, 0);
  assert.doesNotMatch(JSON.stringify(ctx._notes), /supersecret1234567890/);
  assert.doesNotMatch(JSON.stringify(ctx._events), /supersecret1234567890/);
  assert.doesNotMatch(JSON.stringify(ctx._state().openEscalations), /supersecret1234567890/);
  assert.doesNotMatch(persistedBlob(sid), /supersecret1234567890/);
  assert.match(JSON.stringify(ctx._state().openEscalations), /\[redacted-key\]/);
}

{
  const sid = 's_copilot_recovery_answer_bypass';
  const ctx = makeCtx({
    sid,
    question: 'The builder exited unexpectedly. What should Co-pilot do?',
    decision: {
      action: 'answer',
      answer: 'In co-pilot mode, likewise resume the builder with the available resume actuator.',
      recommendation: '',
      reason_code: 'none',
      reason: 'This is a routine recovery.',
      audience: 'builder_blocked',
      confidence: 0.99,
      reserved: false,
    },
  });
  await __lab.runAnswer(ctx, CFG, { terminal_tail: '', recent_messages: [], git: {} }, 'question', 0, SNAPSHOT, 0);
  assert.equal(ctx._sends.length, 0, 'an affirmative Co-pilot recovery cannot send through kind=answer');
  assert.equal(ctx._state().openEscalations?.length, 1, 'the diagnosed recovery is held as an operator-facing handoff');
  const row = db.prepare('SELECT kind, assessment, message, sent FROM supervisor_reviews WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sid);
  assert.equal(row.kind, 'escalate');
  assert.equal(row.sent, 0);
  assert.equal(row.message, '');
  assert.match(row.assessment, /does not hold state-changing recovery authority/i);
}

try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
console.log('supervisor_secret_scrub.test ok');
