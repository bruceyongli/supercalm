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
  const kw = renderIntent('KEEP_WORKING', { focus: 'Execute Supervisor v4 Phase 1' });
  assert.equal(kw.ok, true);
  assert.equal(kw.kind, 'nudge');
  assert.ok(kw.text.startsWith('You stopped mid-task') && kw.text.includes('Phase 1'), 'verbatim template + focus interpolation');
  assert.equal(renderIntent('KEEP_WORKING', {}).ok, true, 'focus is optional');

  const un = renderIntent('UNSTICK_DIRECTION', { text: 'Run the failing test first, then fix the import cycle.' });
  assert.deepEqual([un.ok, un.kind], [true, 'nudge']);
  assert.equal(renderIntent('UNSTICK_DIRECTION', { text: 'see /path/to/model' }).ok, false, 'passthrough hygiene holds');

  const rn = renderIntent('RECOVER_NOTE', { text: 'Session resumed after unexpected exit; continue the active task.' });
  assert.deepEqual([rn.ok, rn.kind], [true, 'recover']);
}

console.log('intents: all assertions passed');
