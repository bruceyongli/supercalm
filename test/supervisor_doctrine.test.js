import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-doctrine-'));

const {
  distillFromDecision, validateCandidate, isTrivialReply, findSimilar,
  listDoctrine, updateDoctrine, deleteDoctrine, retrieveDoctrine, formatDoctrine, noteDoctrineReuse,
  buildDoctrineUserText, SYS_DOCTRINE,
} = await import('../src/agents/doctrine.js');
const { buildAnswerUserText } = await import('../src/agents/answer_prompt.js');

// ---- prompt + validation basics ---------------------------------------------
{
  assert.match(SYS_DOCTRINE, /doctrine-fix/);
  assert.match(SYS_DOCTRINE, /worth_learning/);
  const u = buildDoctrineUserText({ ask: 'may I proceed?', response: 'explain the architecture first', supervisorTake: '[answer/answered] proceed', category: 'decision', project: 'aios' });
  assert.match(u, /BUILDER ASK:/);
  assert.match(u, /SUPERVISOR'S TAKE/);
  assert.match(u, /OPERATOR ACTUALLY REPLIED:/);

  assert.equal(isTrivialReply('ok'), true);
  assert.equal(isTrivialReply('/compact'), true);
  assert.equal(isTrivialReply('go ahead'), true);
  assert.equal(isTrivialReply('Why do we keep repeating this line? Explain the routing architecture.'), false);

  assert.equal(validateCandidate(null), null);
  assert.equal(validateCandidate({ worth_learning: false }), null);
  assert.equal(validateCandidate({ worth_learning: true, kind: 'context', rule: 'x'.repeat(40) }), null, 'context kind never becomes doctrine');
  assert.equal(validateCandidate({ worth_learning: true, kind: 'doctrine-fix', rule: 'too short' }), null, 'thin rules are dropped');
  const ok = validateCandidate({ worth_learning: true, kind: 'doctrine-fix', situation: 's', rule: 'When the builder demos behavior propped up by a prompt crutch, demand the architecture explanation.', apply_how: 'ask why', divergence: 'sup said ok' });
  assert.ok(ok && ok.rule.length > 20);
}

// ---- distillation: candidate creation, filtering, idempotency ----------------
const RULE_A = 'When the builder demos behavior propped up by a prompt crutch, do not accept the demo — demand the routing/memory architecture explanation.';
const goodCall = async () => JSON.stringify({ worth_learning: true, kind: 'doctrine-fix', situation: 'builder demos a fix that relies on repeated prompt instructions', rule: RULE_A, apply_how: 'ask why the system needs the crutch before accepting', divergence: 'supervisor accepted the demo; operator dug into architecture' });
const dec = (id, over = {}) => ({ id, session_id: 's_test', project_id: 'p_test', asked_at: Date.now() - 60000, responded_at: Date.now(), category: 'review', summary: 'agent finished testing memory', question: '', ask: 'Finished testing the memory system; waiting for your feedback.', response: 'Why do we keep repeating 不要用工具? I thought memory is the first thing. What is our current architecture?', ...over });

{
  const r = await distillFromDecision(dec(1), { call: goodCall, project: 'openhand' });
  assert.equal(r.status, 'candidate', 'good doctrine-fix becomes a candidate');
  const rows = listDoctrine();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'candidate');
  assert.equal(rows[0].decision_id, 1);
  assert.match(rows[0].rule, /prompt crutch/);

  // idempotent per decision id
  const again = await distillFromDecision(dec(1), { call: goodCall });
  assert.equal(again.skipped, 'already-distilled');

  // trivial replies never hit the model
  const triv = await distillFromDecision(dec(2, { response: 'ok' }), { call: async () => { throw new Error('must not be called'); } });
  assert.equal(triv.skipped, 'trivial-reply');

  // context-kind results are dropped
  const ctx = await distillFromDecision(dec(3), { call: async () => JSON.stringify({ worth_learning: true, kind: 'context', rule: 'Use port 8793 for this project because that is the configured one.' }) });
  assert.equal(ctx.skipped, 'not-doctrine');
  assert.equal(listDoctrine().length, 1);
}

// ---- dedupe: near-dup of existing bumps evidence; near-dup of rejected is never re-proposed ----
{
  const nearDup = async () => JSON.stringify({ worth_learning: true, kind: 'doctrine-fix', situation: 'builder demos a fix relying on repeated prompt instructions', rule: 'When the builder demos behavior propped up by a prompt crutch, demand the routing/memory architecture explanation instead of accepting the demo.', apply_how: '', divergence: '' });
  const r = await distillFromDecision(dec(4), { call: nearDup });
  assert.ok(r.merged, 'near-duplicate of an existing rule merges (evidence bump), no new row');
  const row = listDoctrine()[0];
  assert.equal(row.evidence_count, 2);
  assert.equal(listDoctrine().length, 1);

  // reject it, then try to re-learn the same thing → silently skipped
  updateDoctrine(row.id, { status: 'rejected' });
  const r2 = await distillFromDecision(dec(5), { call: nearDup });
  assert.equal(r2.skipped, 'similar-to-rejected', 'rejected doctrine is a standing negative example');
  assert.equal(listDoctrine().length, 1);
  deleteDoctrine(row.id);
  assert.equal(listDoctrine().length, 0);
}

// ---- lifecycle: approve-with-edit is one call; retrieval serves ONLY active rules ----
{
  await distillFromDecision(dec(6), { call: goodCall });
  const cand = listDoctrine()[0];
  assert.equal(retrieveDoctrine({ queryText: 'prompt crutch demo' }).length, 0, 'candidates are NOT served — approval is the deployment');

  const edited = updateDoctrine(cand.id, { status: 'active', rule: 'When a demo leans on repeated prompt instructions, require the underlying architecture explanation before accepting it.' });
  assert.equal(edited.status, 'active');
  assert.match(edited.rule, /architecture explanation/);

  const served = retrieveDoctrine({ queryText: 'builder demo relies on prompt instructions' });
  assert.equal(served.length, 1, 'active rules are served');
  const block = formatDoctrine(served);
  assert.match(block, /OPERATOR_DOCTRINE/);
  assert.match(block, /architecture explanation/);
  assert.match(block, /WHEN builder demos/i);

  // the block lands in the answer prompt; absent doctrine leaves the baseline untouched
  const withD = buildAnswerUserText({ question: 'q', doctrine: block });
  assert.match(withD, /OPERATOR_DOCTRINE/);
  const withoutD = buildAnswerUserText({ question: 'q' });
  assert.doesNotMatch(withoutD, /OPERATOR_DOCTRINE/);

  noteDoctrineReuse(served.map((r) => r.id));
  assert.equal(listDoctrine()[0].reuse_count, 1);
}

// ---- retrieval ranking: beyond k, overlap with the ask decides ----------------
{
  const topics = [
    { s: 'agent asks about database migrations schema', r: 'Require reversible migration scripts plus a rollback command before approving schema changes to postgres tables.' },
    { s: 'agent proposes shipping without screenshots', r: 'Visual frontend changes need rendered browser screenshots as proof, never markup descriptions alone.' },
    { s: 'agent hits flaky network timeouts', r: 'Transient network timeout errors get two retries with backoff before escalating infrastructure problems upward.' },
    { s: 'agent wants to bump dependency versions', r: 'Dependency upgrades require reading changelog breaking sections and running the full suite locally.' },
    { s: 'agent asks whether to write docs', r: 'Documentation edits accompany behavior changes in the same commit, covering gotchas and env knobs.' },
    { s: 'agent stuck choosing test framework', r: 'Prefer zero-dependency node builtin test runners over adding jest or vitest packages.' },
    { s: 'agent asks about logging verbosity', r: 'Keep production logging sparse: one line per lifecycle event, errors with context, nothing per-tick.' },
    { s: 'agent negotiating git branch strategy', r: 'Feature branches merge fast-forward onto main after review; nobody force-pushes shared history ever.' },
  ];
  for (let i = 0; i < topics.length; i++) {
    const r = await distillFromDecision(dec(100 + i), {
      call: async () => JSON.stringify({ worth_learning: true, kind: 'doctrine-fix', situation: topics[i].s, rule: topics[i].r, apply_how: '', divergence: '' }),
    });
    assert.ok(r.id, `distinct topic ${i} inserts a new row (not merged)`);
    updateDoctrine(r.id, { status: 'active' });
  }
  const all = retrieveDoctrine({ queryText: 'anything' , k: 20 });
  assert.ok(all.length >= 9, 'all active rules eligible');
  const top = retrieveDoctrine({ queryText: 'demo leans on repeated prompt instructions architecture', k: 3 });
  assert.equal(top.length, 3);
  assert.match(top[0].rule, /architecture explanation/, 'overlap ranks the matching rule first');
}

// ---- both live seams exist: runAnswer (OPERATOR_DOCTRINE via buildAnswerUserText) + runVerify evidence ----
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
  assert.match(src, /retrieveDoctrine/, 'supervisor retrieves doctrine');
  assert.ok(src.split('retrieveDoctrine(').length >= 3, 'doctrine reaches BOTH the answer and verify paths');
  assert.match(src, /operator_doctrine/, 'verify evidence carries the doctrine block');
  assert.match(src, /noteDoctrineReuse/, 'injection bumps reuse counters');
}

console.log('supervisor_doctrine.test ok');
