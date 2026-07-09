import assert from 'node:assert/strict';

const { MODES, modeOf, copilotThreshold, sendPolicy, DEFAULT_COPILOT_CONFIDENCE, cardLifecycleDirective } = await import('../src/agents/supervisor/send_policy.js');

// ---- modeOf: legacy resolution (mode wins; observe_only only as fallback; NEVER default-merged) ----
{
  assert.equal(modeOf({}), 'autopilot', 'legacy config with neither key keeps the pre-mode behavior');
  assert.equal(modeOf({ observe_only: true }), 'observe');
  assert.equal(modeOf({ observe_only: false }), 'autopilot');
  assert.equal(modeOf({ mode: 'copilot', observe_only: true }), 'copilot', 'explicit mode outranks legacy flag');
  assert.equal(modeOf({ mode: 'observe', observe_only: false }), 'observe');
  assert.equal(modeOf({ mode: 'bogus' }), 'autopilot', 'unknown mode falls back to legacy resolution');
  assert.deepEqual(MODES, ['observe', 'copilot', 'autopilot']);
}

// ---- threshold clamping ----
{
  assert.equal(copilotThreshold({}), DEFAULT_COPILOT_CONFIDENCE);
  assert.equal(copilotThreshold({ copilot_confidence: 0.5 }), 0.5);
  assert.equal(copilotThreshold({ copilot_confidence: 7 }), 1);
  assert.equal(copilotThreshold({ copilot_confidence: -1 }), 0);
  assert.equal(copilotThreshold({ copilot_confidence: 'NaNish' }), DEFAULT_COPILOT_CONFIDENCE);
}

// ---- observe: everything drafts (except operator) ----
for (const kind of ['answer', 'challenge', 'nudge', 'recover']) {
  const p = sendPolicy('observe', kind, { confidence: 1, reserved: false });
  assert.equal(p.allowed, false, `observe blocks ${kind}`);
  assert.equal(p.reason, 'mode-observe');
}

// ---- autopilot: everything sends ----
for (const kind of ['answer', 'challenge', 'nudge', 'recover']) {
  assert.equal(sendPolicy('autopilot', kind, {}).allowed, true, `autopilot sends ${kind}`);
}

// ---- operator kind bypasses every mode ----
for (const mode of MODES) {
  assert.equal(sendPolicy(mode, 'operator', {}).allowed, true, `operator relay sends in ${mode}`);
}

// ---- copilot matrix ----
{
  // challenges (evidence demands) always send
  assert.equal(sendPolicy('copilot', 'challenge', {}).allowed, true);
  // nudges and recoveries draft, with distinguishable reasons
  assert.deepEqual(sendPolicy('copilot', 'nudge', {}), { allowed: false, reason: 'mode-copilot-holds-nudge' });
  assert.deepEqual(sendPolicy('copilot', 'recover', {}), { allowed: false, reason: 'mode-copilot-holds-recover' });
  // confident non-reserved answer sends
  assert.equal(sendPolicy('copilot', 'answer', { confidence: 0.9, reserved: false }).allowed, true);
  assert.equal(sendPolicy('copilot', 'answer', { confidence: 0.8, reserved: false }).allowed, true, 'threshold is inclusive');
  // below threshold drafts
  assert.deepEqual(sendPolicy('copilot', 'answer', { confidence: 0.79, reserved: false }), { allowed: false, reason: 'mode-copilot-confidence' });
  // custom threshold honored
  assert.equal(sendPolicy('copilot', 'answer', { confidence: 0.6, reserved: false, threshold: 0.5 }).allowed, true);
  // FAIL-CLOSED: missing/invalid confidence never sends
  assert.deepEqual(sendPolicy('copilot', 'answer', { reserved: false }), { allowed: false, reason: 'mode-copilot-no-confidence' });
  assert.equal(sendPolicy('copilot', 'answer', { confidence: 'high', reserved: false }).allowed, false);
  // FAIL-CLOSED: reserved missing or true never sends (model must positively confirm reserved:false)
  assert.deepEqual(sendPolicy('copilot', 'answer', { confidence: 0.95 }), { allowed: false, reason: 'mode-copilot-reserved-unconfirmed' });
  assert.equal(sendPolicy('copilot', 'answer', { confidence: 0.95, reserved: true }).allowed, false);
}

// ---- unknown mode string degrades to legacy autopilot behavior (never bricks sends) ----
assert.equal(sendPolicy('weird', 'answer', {}).allowed, true);

// ---- cardLifecycleDirective: the operator-reserved card-admin backstop (self-echo incident) ----
{
  // THE incident text (verbatim shape) must be caught in every mode
  assert.equal(cardLifecycleDirective('Start the pending \u201cWorkflow Editor design + connection fixes\u201d card as the active task. Treat the Workflow log UI redesign card as done/closed rather than merging the two goals; preserve its history, then continue on the editor card.'), true, 'the real incident directive is caught');
  assert.equal(cardLifecycleDirective('Close the current card as done and start the next one.'), true);
  assert.equal(cardLifecycleDirective('Activate task card task_9caa308172.'), true);
  assert.equal(cardLifecycleDirective('Abandon this card; the goal moved.'), true);
  assert.equal(cardLifecycleDirective('Treat the log-UI work as done and move on.'), true);
  assert.equal(cardLifecycleDirective('Resume the paused card for the editor work.'), true);
  // Ordinary engineering directives must NOT trip it — builders legitimately work ON card UI code
  assert.equal(cardLifecycleDirective('Fix the null deref in renderTaskCard and add a test.'), false);
  assert.equal(cardLifecycleDirective('Add a Dismiss button to the card banner component.'), false);
  assert.equal(cardLifecycleDirective('Run the suite, then commit.'), false);
  assert.equal(cardLifecycleDirective('The card component should render the archive drawer collapsed.'), false);
  assert.equal(cardLifecycleDirective(''), false);
  assert.equal(cardLifecycleDirective(null), false);
}

// ---- source locks: the self-echo guards stay wired into the live answer path ----
{
  const { readFileSync } = await import('node:fs');
  const sup = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
  assert.match(sup, /SCOPE_CARD_ADMIN_ADDENDUM; \/\/ self-echo hardening/, 'scope addendum compiled into runAnswer sys');
  assert.match(sup, /cardLifecycleDirective\(answer\)/, 'deterministic lifecycle guard runs on the drafted answer');
  assert.match(sup, /BETWEEN TASKS: there is NO active contract/, 'between-tasks answers are restraint-scoped');
  assert.match(sup, /activeTaskId: null, activeCardVersion: null, activeCardHash: null/, 'between-tasks clears stale contract attribution');
  const ap = readFileSync(new URL('../src/agents/answer_prompt.js', import.meta.url), 'utf8');
  assert.match(ap, /SCOPE & CARD ADMINISTRATION — HARD RULES/, 'addendum text present');
  assert.match(ap, /not your jurisdiction/i, 'subject-matter vs jurisdiction rule present');
  const pm = readFileSync(new URL('../src/agents/supervisor/project_memory.js', import.meta.url), 'utf8');
  assert.match(pm, /Choosing, starting, or closing/, 'between-tasks contract names card admin as operator territory');

  // Choke point: the dispatcher blocks card-lifecycle text on EVERY path/mode except the operator
  // relay — so no current or future call site can forget the guard.
  const disp = readFileSync(new URL('../src/agents/supervisor/dispatch.js', import.meta.url), 'utf8');
  assert.match(disp, /ruleId !== 'hold\.resolve_send' && cardLifecycleDirective\(msg\)/, 'dispatcher-level lifecycle block, operator relay exempt');
  assert.match(disp, /card-lifecycle-operator-reserved/, 'distinct suppression reason for the panel feed');
  // The jurisdiction addendum rides EVERY steering prompt, not just answers.
  assert.match(sup, /SYS_UNSTICK \+ '\\n\\n' \+ SCOPE_CARD_ADMIN_ADDENDUM/, 'unstick prompt carries jurisdiction rules');
  assert.ok(/sys \+= '\\n\\n' \+ SCOPE_CARD_ADMIN_ADDENDUM; \/\/ self-echo hardening: verify/.test(sup), 'verify prompt carries jurisdiction rules');
}

console.log('supervisor_send_policy.test ok');
