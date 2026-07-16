import assert from 'node:assert/strict';

const { tickSignature, gateTick, eventGateEnabled, HEARTBEAT_MS } = await import('../src/agents/supervisor/event_gate.js');

const T0 = 1_800_000_000_000;
const base = { status: 'working', question: '', category: '', stage: '', paneSig: 'abc', docRev: 'd1', stanceTs: 's1', activeTaskId: '' };

// ---- signature: stable for identical inputs, moves on ANY component ----
{
  assert.equal(tickSignature(base), tickSignature({ ...base }), 'same inputs -> same signature');
  for (const [k, v] of [
    ['status', 'waiting'], ['question', 'proceed?'], ['category', 'review'], ['stage', 'plan'],
    ['paneSig', 'zzz'], ['docRev', 'd2'], ['stanceTs', 's2'], ['activeTaskId', 'tk_1'],
  ]) {
    assert.notEqual(tickSignature({ ...base, [k]: v }), tickSignature(base), `${k} change moves the signature`);
  }
}

// ---- gate: first tick runs; unchanged skips; change runs; heartbeat runs; error episode runs ----
{
  const sig = tickSignature(base);
  const first = gateTick({}, sig, T0);
  assert.equal(first.run, true, 'first tick always runs');
  assert.equal(first.reason, 'signature-changed');
  const st = { tickSig: first.patch.tickSig, tickRanAt: first.patch.tickRanAt };

  const idle = gateTick(st, sig, T0 + 15_000);
  assert.equal(idle.run, false, 'unchanged signature within the heartbeat skips');
  assert.equal(idle.reason, 'no-event');
  assert.equal(idle.patch, null, 'a skipped tick writes NOTHING');

  const moved = gateTick(st, tickSignature({ ...base, paneSig: 'moved' }), T0 + 30_000);
  assert.equal(moved.run, true, 'pane change runs the tick');

  const beat = gateTick(st, sig, T0 + HEARTBEAT_MS + 1);
  assert.equal(beat.run, true, 'heartbeat elapses -> full pass (timeout is an event)');
  assert.equal(beat.reason, 'heartbeat');

  const err = gateTick({ ...st, errSig: '429 rate limit' }, sig, T0 + 15_000);
  assert.equal(err.run, true, 'an active API-error episode always runs (its backoff is minute-granular)');
  assert.equal(err.reason, 'error-episode');

  const custom = gateTick(st, sig, T0 + 90_000, { heartbeatMs: 60_000 });
  assert.equal(custom.run, true, 'caller-tightened heartbeat (stuck/checkpoint timers) is honored');
}

// ---- kill-switch mutation check: default ON; disabled -> every tick runs (pre-Phase-0 behavior) ----
{
  assert.equal(eventGateEnabled(), true, 'gate must default ON');
  const sig = tickSignature(base);
  const st = gateTick({}, sig, T0).patch;
  process.env.AIOS_EVENT_GATE = '0';
  const v = gateTick(st, sig, T0 + 15_000);
  assert.equal(v.run, true, 'kill-switch off -> ticks run unconditionally');
  assert.equal(v.reason, 'gate-disabled');
  process.env.AIOS_EVENT_GATE = '1';
  assert.equal(gateTick(st, sig, T0 + 15_000).run, false, 'MUTATION CHECK: gate back on -> the same idle tick skips again');
}

console.log('supervisor_event_gate: all assertions passed');
