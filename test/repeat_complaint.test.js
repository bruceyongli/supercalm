import assert from 'node:assert/strict';

const { detectRepeatedComplaint } = await import('../src/agents/supervisor/repeat_complaint.js');

const T = 1_800_000_000_000;
const M = (ts, text) => ({ ts, text });

// re-raised complaint (rephrased) across a real gap -> repeated
const r = detectRepeatedComplaint([
  M(T + 3600e3, 'the login button on the dashboard is still broken after your fix'),
  M(T + 1800e3, 'ship the next milestone when ready'),
  M(T, 'login button broken on dashboard — clicking it does nothing'),
]);
assert.equal(r.repeated, true);
assert.ok(r.similarity >= 0.45);
assert.ok(r.latest.text.includes('still broken'));

// unrelated messages -> no repeat
assert.equal(detectRepeatedComplaint([
  M(T + 3600e3, 'now build the export feature for reports'),
  M(T, 'the color of the sidebar should be darker'),
]).repeated, false);

// impatient double-Enter (same text seconds apart) -> NOT a repeat (needs a real gap)
assert.equal(detectRepeatedComplaint([
  M(T + 20e3, 'fix the failing deploy pipeline gate'),
  M(T, 'fix the failing deploy pipeline gate'),
]).repeated, false);

// short acks never trip
assert.equal(detectRepeatedComplaint([M(T + 3600e3, 'ok'), M(T, 'ok')]).repeated, false);

console.log('repeat_complaint: all assertions passed');
