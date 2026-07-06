import assert from 'node:assert/strict';

const { MODES, modeOf, copilotThreshold, sendPolicy, DEFAULT_COPILOT_CONFIDENCE } = await import('../src/agents/supervisor/send_policy.js');

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

console.log('supervisor_send_policy.test ok');
