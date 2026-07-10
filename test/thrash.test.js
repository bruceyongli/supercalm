// Fleet-thrash detector: pure logic on synthetic commit streams (the lab covers the wired path).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.AIOS_DATA = mkdtempSync(join(tmpdir(), 'aios-thrash-'));
const assert = (await import('node:assert/strict')).default;
const { detectThrash } = await import('../src/agents/supervisor/thrash.js');

const c = (sha, subject, files = ['auth.js']) => ({ sha, ts: Date.now(), subject, files });

// revert-oscillation: the incident shape
{
  const r = detectThrash([
    c('a1', 'revert: guard also breaks login'), c('a2', 'reapply: cookie with guard'),
    c('a3', 'revert: session cookie broke prod'), c('a4', 'fix: session cookie'), c('a5', 'feat: login'),
  ]);
  assert.equal(r.thrash, true);
  assert.equal(r.kind, 'revert-oscillation');
  assert.ok(r.files.includes('auth.js'), 'oscillating file named');
  assert.match(r.episodeKey, /^thrash\|a5\|/, 'episode anchored to the oldest in-window commit');
}
// same stream -> same episode key (once-per-episode depends on it)
{
  const mk = () => detectThrash([c('a1', 'revert: x'), c('a2', 'reapply: x'), c('a3', 'revert: y'), c('a4', 'feat: z')]);
  assert.equal(mk().episodeKey, mk().episodeKey);
}
// benign work never trips it
{
  const r = detectThrash([c('b1', 'feat: add settings'), c('b2', 'fix: overflow'), c('b3', 'test: locks'), c('b4', 'docs: ledger')]);
  assert.equal(r.thrash, false);
}
// deploy churn REQUIRES a revert marker — pure release cadence is normal work, not thrash
{
  const cadence = detectThrash([c('d1', 'release: v9'), c('d2', 'release: v8'), c('d3', 'release: v7'), c('d4', 'release: v6'), c('d5', 'release: v5'), c('d6', 'feat: x')]);
  assert.equal(cadence.thrash, false, 'solo release cadence must never hold the operator');
  const churn = detectThrash([c('d1', 'release: v9', ['a.js']), c('d2', 'revert: v8 broke login', ['b.js']), c('d3', 'release: v8', ['c.js']), c('d4', 'release: v7', ['d.js']), c('d5', 'release: v6', ['e.js']), c('d6', 'release: v5', ['f.js'])]);
  assert.equal(churn.thrash, true);
  assert.equal(churn.kind, 'deploy-churn');
}
// too little history = no verdict
assert.equal(detectThrash([c('x', 'revert: y')]).thrash, false);

console.log('thrash.test ok');
process.exit(0);
