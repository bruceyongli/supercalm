// Autonomous integrate-&-deploy — the AI REVIEWER PANEL (plan §7). The LLM call is injected, so this is
// deterministic: all-PASS → pass; any FAIL → blocked; a PASS with high severity still blocks; a reviewer
// that throws (fleet down) FAILS CLOSED. Reviewers are chosen by their (trusted) lens prompt, so the fake
// can key off the message content.
import assert from 'node:assert/strict';

const { reviewCandidate } = await import('../src/deploy_reviewers.js');

// all reviewers PASS → panel passes
const allPass = async () => ({ obj: { verdict: 'PASS', severity: 'none', summary: 'ok', findings: [] }, model: 'fake' });
let r = await reviewCandidate({ diffText: 'some diff', files: ['a.js'] }, { chatJsonFn: allPass });
assert.equal(r.pass, true, 'all PASS → pass');
assert.equal(r.reviews.length, 3, 'three independent lenses ran');

// the prod-failure reviewer FAILs → panel blocks, names that lens
const prodFails = async (messages) => ({ obj: /SRE/.test(messages[0].content) ? { verdict: 'FAIL', severity: 'high', summary: 'breaks prod', findings: ['x'] } : { verdict: 'PASS', severity: 'none' }, model: 'fake' });
r = await reviewCandidate({ diffText: 'd', files: [] }, { chatJsonFn: prodFails });
assert.equal(r.pass, false, 'a single FAIL blocks the panel');
assert.deepEqual(r.blocking, ['prod_failure'], 'blocking names the failing lens');

// a PASS verdict but high severity still blocks (belt + suspenders)
const passButHigh = async () => ({ obj: { verdict: 'PASS', severity: 'high', summary: 'risky', findings: [] }, model: 'fake' });
r = await reviewCandidate({ diffText: 'd', files: [] }, { chatJsonFn: passButHigh });
assert.equal(r.pass, false, 'PASS + high severity still blocks');

// reviewer throws (fleet down) → fail-closed, never auto-approve unreviewed
const down = async () => { throw new Error('fleet down'); };
r = await reviewCandidate({ diffText: 'd', files: [] }, { chatJsonFn: down });
assert.equal(r.pass, false, 'reviewer unavailable → fail-closed');
assert.ok(r.reviews.every((x) => x.error && x.verdict === 'FAIL'), 'all marked error + FAIL');

// the diff is length-capped (injection-surface + cost bound)
const big = 'x'.repeat(200000);
let seenLen = 0;
const measure = async (messages) => { seenLen = Math.max(seenLen, messages[1].content.length); return { obj: { verdict: 'PASS', severity: 'none' }, model: 'fake' }; };
await reviewCandidate({ diffText: big, files: [] }, { chatJsonFn: measure });
assert.ok(seenLen < 100000, 'diff is capped before it reaches the reviewer (got ' + seenLen + ')');

console.log('deploy_reviewers.test: all assertions passed');
