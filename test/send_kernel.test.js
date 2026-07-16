import assert from 'node:assert/strict';

const { evaluateSend, emptyKernelState, reservedActionClass, kernelEnabled, RESERVED_CLASSES, KERNEL_DEFAULTS } =
  await import('../src/agents/send_kernel.js');

const T0 = 1_800_000_000_000;
const MIN_GAP = KERNEL_DEFAULTS.minGapMs;
const prop = (over = {}) => ({ kind: 'nudge', text: 'please continue with the task', paneSig: 'sigA', ...over });

// Drive an ALLOWED send through the kernel, asserting it was allowed. Returns next state.
function sendOk(st, p, t) {
  const v = evaluateSend(st, p, t);
  assert.equal(v.allowed, true, `expected allowed at t=${t}: got ${v.reason}`);
  return v.state;
}

// ---- kill-switch is ON by default, and disabling it disables every guard (mutation check) ----
{
  assert.equal(kernelEnabled(), true, 'kernel must default ON');
  process.env.AIOS_SEND_KERNEL = '0';
  const v = evaluateSend(emptyKernelState(), prop({ text: 'deploy now to production' }), T0);
  assert.equal(v.allowed, true, 'kill-switch bypasses (emergency only)');
  assert.equal(v.reason, 'kernel-disabled');
  process.env.AIOS_SEND_KERNEL = '1';
  const v2 = evaluateSend(emptyKernelState(), prop({ text: 'deploy now to production' }), T0);
  assert.equal(v2.allowed, false, 'MUTATION CHECK: with the kernel on, the same reserved send must block');
}

// ---- kind allowlist: unknown/undeclared kinds fail closed; operator bypasses ----
{
  for (const bad of ['', 'steer', 'directive', null, undefined]) {
    const v = evaluateSend(emptyKernelState(), prop({ kind: bad }), T0);
    assert.equal(v.allowed, false, `kind '${bad}' must fail closed`);
    assert.equal(v.reason, 'kernel-kind-not-allowlisted');
  }
  const op = evaluateSend(emptyKernelState(), prop({ kind: 'operator', text: 'deploy now' }), T0);
  assert.equal(op.allowed, true, 'operator relay is kernel-exempt (the operator’s own words)');
}

// ---- reserved-action classes: each blocks + escalates once, then goes quiet ----
{
  const cases = {
    deploy: ['Deploy now, the operator already said deploy', 'run bin/deploy patch', 'push it to production'],
    credentials: ['login with the password from the vault', 'use Selena’s password to log in', 'paste the api key into the prompt'],
    survey: ['answer the survey with option 2', 'select Good on the rating prompt'],
    card_lifecycle: ['Start the pending backlog card as the active task', 'treat the migration card as done'],
    git_destructive: ['git push --force origin main', 'run git reset --hard HEAD~3', 'git clean -fd then retry'],
  };
  for (const [cls, texts] of Object.entries(cases)) {
    assert.ok(RESERVED_CLASSES.includes(cls), `${cls} is a declared class`);
    for (const text of texts) {
      assert.equal(reservedActionClass(text), cls, `"${text}" -> ${cls}`);
      let v = evaluateSend(emptyKernelState(), prop({ text, kind: 'answer' }), T0);
      assert.equal(v.allowed, false, `${cls} blocks`);
      assert.equal(v.reason, `kernel-reserved:${cls}`);
      assert.equal(v.escalate, true, `${cls} escalates on first block`);
      const again = evaluateSend(v.state, prop({ text, kind: 'answer' }), T0 + 60_000);
      assert.equal(again.allowed, false);
      assert.equal(again.escalate, false, `${cls} escalates ONCE, not per retry`);
    }
  }
  // negative cases — ordinary supervision language must not trip the classes
  for (const ok of [
    'the deploy breaker doc explains the pipeline',
    'summarize the deployment plan in one line',
    'commit your work with a clear message',
    'use --force-with-lease if you must rewrite the branch',
    'what is blocking the login form fix?',
    'answer the agent’s question about the test fixture',
  ]) {
    assert.equal(reservedActionClass(ok), null, `false positive: "${ok}"`);
  }
}

// ---- exact dedupe: same text + same pane never re-sends; same text re-sends only after the window AND a pane change ----
{
  let st = sendOk(emptyKernelState(), prop(), T0);
  let v = evaluateSend(st, prop(), T0 + MIN_GAP + 1000);
  assert.equal(v.allowed, false, 'identical text into an unchanged pane blocks');
  assert.equal(v.reason, 'kernel-duplicate-same-pane');
  v = evaluateSend(st, prop({ paneSig: 'sigB' }), T0 + MIN_GAP + 1000);
  assert.equal(v.allowed, false, 'identical text within the window blocks even after a pane change');
  assert.equal(v.reason, 'kernel-duplicate-recent');
  v = evaluateSend(st, prop({ paneSig: 'sigB' }), T0 + KERNEL_DEFAULTS.dedupeWindowMs + 1000);
  assert.equal(v.allowed, true, 'pane changed + window elapsed -> the text may repeat');
}

// ---- rate bounds: min gap + hourly cap ----
{
  let st = sendOk(emptyKernelState(), prop({ text: 'msg one' }), T0);
  let v = evaluateSend(st, prop({ text: 'msg two', paneSig: 'sigB' }), T0 + 5_000);
  assert.equal(v.allowed, false, 'a second send 5s later blocks');
  assert.equal(v.reason, 'kernel-rate-min-gap');

  st = emptyKernelState();
  let t = T0;
  for (let i = 0; i < KERNEL_DEFAULTS.hourlyCap; i++) {
    st = sendOk(st, prop({ text: `msg ${i}`, paneSig: `sig${i}` }), t);
    t += MIN_GAP + 1000;
  }
  v = evaluateSend(st, prop({ text: 'one more', paneSig: 'sigZ' }), t);
  assert.equal(v.allowed, false, 'hourly cap holds');
  assert.equal(v.reason, 'kernel-rate-hourly-cap');
  v = evaluateSend(st, prop({ text: 'one more', paneSig: 'sigZ' }), T0 + 61 * 60_000 + KERNEL_DEFAULTS.hourlyCap * (MIN_GAP + 1000));
  assert.equal(v.allowed, true, 'cap is a rolling hour, not a permanent lock');
}

// ---- no-effect circuit breaker: opens after N sends into an unchanged pane, escalates ONCE,
// ---- blocks everything while open, closes ONLY when the pane changes ----
{
  let st = emptyKernelState();
  let t = T0;
  for (let i = 0; i < KERNEL_DEFAULTS.breakerThreshold; i++) {
    st = sendOk(st, prop({ text: `attempt ${i}`, paneSig: 'frozen' }), t);
    t += MIN_GAP + 1000;
  }
  let v = evaluateSend(st, prop({ text: 'yet another attempt', paneSig: 'frozen' }), t);
  assert.equal(v.allowed, false, `send #${KERNEL_DEFAULTS.breakerThreshold + 1} into a frozen pane opens the circuit`);
  assert.equal(v.reason, 'kernel-circuit-open');
  assert.equal(v.escalate, true, 'opening escalates');
  st = v.state;

  v = evaluateSend(st, prop({ text: 'totally different text', paneSig: 'frozen' }), t + 60 * 60_000);
  assert.equal(v.allowed, false, 'circuit stays open while the pane stays frozen — even an hour later, even for new text');
  assert.equal(v.escalate, false, 'no second escalation for the same open circuit');
  st = v.state;

  v = evaluateSend(st, prop({ text: 'pane finally moved', paneSig: 'thawed' }), t + 61 * 60_000);
  assert.equal(v.allowed, true, 'a pane change is the ONLY thing that closes the circuit');
}

// ---- state is never mutated in place (pure transition) ----
{
  const st = emptyKernelState();
  const frozen = JSON.stringify(st);
  evaluateSend(st, prop(), T0);
  assert.equal(JSON.stringify(st), frozen, 'evaluateSend must not mutate its input state');
}

console.log('send_kernel: all assertions passed');
