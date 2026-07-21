import assert from 'node:assert/strict';

const { INTENTS, INTENT_NAMES, renderIntent } = await import('../src/agents/intents.js');
const { SEND_KINDS } = await import('../src/agents/supervisor/send_policy.js');

// ---- every intent maps to a legal send lane ----
for (const name of INTENT_NAMES) {
  assert.ok(SEND_KINDS.includes(INTENTS[name].kind), `${name} maps to a legal kind`);
}

// ---- happy renders ----
{
  const c = renderIntent('CONTINUE', { reason: 'tests are green, next milestone is Phase 2' });
  assert.equal(c.ok, true);
  assert.equal(c.kind, 'nudge');
  assert.ok(c.text.startsWith('Continue: '));

  const m = renderIntent('ANSWER_MENU', { option: 2 });
  assert.deepEqual([m.ok, m.text, m.kind], [true, '2', 'answer']);

  const a = renderIntent('ANSWER_QUESTION', { text: 'Use the existing helper; do not add a new dependency.' });
  assert.equal(a.ok, true);
  assert.equal(a.kind, 'answer');

  const e = renderIntent('REQUEST_EVIDENCE', { claim: 'login flow fixed', types: ['url probe', 'test run'] });
  assert.equal(e.ok, true);
  assert.equal(e.kind, 'challenge');
  assert.ok(e.text.length < 260, 'challenge templates stay terse — no boilerplate paragraphs');

  const r = renderIntent('RECOVER_COMMAND', { command: '/compact' });
  assert.deepEqual([r.ok, r.text, r.kind], [true, '/compact', 'recover']);
}

// ---- fail-closed: unknown intents and free-form shapes are unrenderable ----
{
  assert.equal(renderIntent('DEPLOY_NOW', {}).ok, false, 'non-allowlisted intent refused');
  assert.equal(renderIntent('', {}).ok, false);
  assert.equal(renderIntent('CONTINUE', {}).ok, false, 'missing required param refused');
  assert.equal(renderIntent('CONTINUE', { reason: 'ok', extra: 'smuggled' }).ok, false, 'unexpected param refused');
  assert.equal(renderIntent('ANSWER_MENU', { option: 12 }).ok, false, 'menu option out of range');
  assert.equal(renderIntent('ANSWER_MENU', { option: '2' }).ok, false, 'menu option must be an integer, not text');
  assert.equal(renderIntent('REQUEST_EVIDENCE', { claim: 'x y z', types: [] }).ok, false, 'evidence types required');
}

// ---- placeholder hygiene (S7: the literal /path/to/model incident) ----
{
  assert.equal(renderIntent('CONTINUE', { reason: 'run scripts at /path/to/model now' }).ok, false, 'scaffold path refused');
  assert.equal(renderIntent('CONTINUE', { reason: 'set {model_name} in the config' }).ok, false, 'unresolved template var refused');
  assert.equal(renderIntent('CONTINUE', { reason: 'fill in <project-name> then run' }).ok, false, 'angle stub refused');
  assert.equal(renderIntent('ANSWER_QUESTION', { text: 'the file is at /path/to/model' }).ok, false, 'answer carrying scaffold path refused');
}

// ---- recover lane: strict command allowlist ----
{
  for (const bad of ['/login', '/logout', '/model gpt-9', 'rm -rf /', '/compact; rm x', '/clear && echo hi']) {
    assert.equal(renderIntent('RECOVER_COMMAND', { command: bad }).ok, false, `recover refuses '${bad}'`);
  }
  assert.equal(renderIntent('RECOVER_COMMAND', { command: '/clear' }).ok, true);
}


// ---- named template + passthrough lanes (call-site migration) ----
{
  const CHECKED = 'git a1b2c3d clean, last commit 42m ago, 2 criteria open';
  const kw = renderIntent('KEEP_WORKING', { focus: 'Execute Supervisor v4 Phase 1', checked: CHECKED });
  assert.equal(kw.ok, true);
  assert.equal(kw.kind, 'nudge');
  assert.ok(kw.text.startsWith('You stopped mid-task') && kw.text.includes('Phase 1'), 'verbatim template + focus interpolation');
  assert.ok(kw.text.includes(`[checked: ${CHECKED}]`), 'the send CITES the observed reality');
  assert.equal(renderIntent('KEEP_WORKING', { checked: CHECKED }).ok, true, 'focus is optional');

  const un = renderIntent('UNSTICK_DIRECTION', { text: 'Run the failing test first, then fix the import cycle.', checked: CHECKED });
  assert.deepEqual([un.ok, un.kind], [true, 'nudge']);
  assert.ok(un.text.includes('[checked:'), 'unstick cites reality too');
  assert.equal(renderIntent('UNSTICK_DIRECTION', { text: 'see /path/to/model', checked: CHECKED }).ok, false, 'passthrough hygiene holds');

  const rn = renderIntent('RECOVER_NOTE', { text: 'Session resumed after unexpected exit; continue the active task.' });
  assert.deepEqual([rn.ok, rn.kind], [true, 'recover']);
}

// ---- CHECK-BEFORE-SEND (2026-07-21 incident: "never done the check, just blindly sending") ----
// A push that cannot cite observed reality is structurally unrenderable — no checked, no send.
{
  assert.equal(renderIntent('KEEP_WORKING', { focus: 'anything' }).ok, false, 'blind keep-working refused');
  assert.equal(renderIntent('KEEP_WORKING', { focus: 'x', checked: '' }).ok, false, 'empty citation refused');
  assert.equal(renderIntent('KEEP_WORKING', { focus: 'x', checked: 'n/a' }).ok, false, 'token citation refused (min length)');
  assert.equal(renderIntent('UNSTICK_DIRECTION', { text: 'Try the other branch first.' }).ok, false, 'blind unstick refused');
  assert.equal(renderIntent('CHALLENGE_TEXT', { text: 'Account for criteria 1-3 before claiming done.' }).ok, false, 'blind challenge refused');
  const ch = renderIntent('CHALLENGE_TEXT', { text: 'Account for criteria 1-3 before claiming done.', checked: 'git 9f8e7d6 dirty(3), last commit 190m ago, 3 criteria open' });
  assert.equal(ch.ok, true);
  assert.ok(ch.text.includes('[checked: git 9f8e7d6'), 'challenge cites reality');
}

console.log('intents: all assertions passed');
