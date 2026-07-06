import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-supervisor-doc-life-'));

const { maintainDoc } = await import('../src/agents/doc_maintainer.js');
const { buildChallenge } = await import('../src/agents/supervisor.js');

const doc = `# Refactor session
## Goal
Ship the whole refactor safely.

## Now
Goal 1: backend index.

## Acceptance criteria
- [x] Backend index exists.
- [ ] Supervisor has current impact output.

## Hard rules
- Deploy only via bin/deploy.

## Decisions & agreements
- Goal 1 must not add visual graph code nodes.
- Keep deploys versioned.

## Timeline
- 2026-06-27: Initial review completed.
`;

{
  const challenge = buildChallenge(doc);
  assert(!challenge.includes('Backend index exists'), 'checked criteria must not be re-demanded');
  assert(challenge.includes('Supervisor has current impact output'), 'unchecked criteria stay live');
}

const result = await maintainDoc({
  doc,
  signalsText: 'reviewer complete: Goal 1 is accepted. operator: move on to Goal 2.',
  now: Date.UTC(2026, 5, 28),
  callModel: async () => ({
    content: JSON.stringify({
      check_criteria: ['Supervisor has current impact output.'],
      completed: [{ task: 'Goal 1 backend index', outcome: 'accepted and archived' }],
      retired_decisions: ['Goal 1 must not add visual graph code nodes.'],
      advanced: {
        now: 'Goal 2: Supervisor uses changed impact during preflight.',
        acceptance: ['Preflight output names affected routes, agents, MCP tools, and wiki surfaces.'],
        reason: 'Goal 1 accepted and operator said move on',
      },
    }),
  }),
});

assert.equal(result.changed, true);
assert.match(result.summary, /advanced focus/);
assert.match(result.summary, /decisions archived/);
assert.match(result.doc, /## Now\nGoal 2: Supervisor uses changed impact during preflight\./);
assert.match(result.doc, /## Archived context/);
assert.match(result.doc, /Goal 1 must not add visual graph code nodes\. — archived; no longer an active gate/);

const activeDecisionSection = result.doc.match(/## Decisions & agreements\n([\s\S]*?)(?:\n## |\n?$)/)?.[1] || '';
assert(!activeDecisionSection.includes('Goal 1 must not add visual graph code nodes'), 'retired decision leaves active Decisions');
assert(activeDecisionSection.includes('Keep deploys versioned'), 'standing decision remains active');

const nextChallenge = buildChallenge(result.doc);
assert(!nextChallenge.includes('Backend index exists'), 'completed criteria stay out of future gates');
assert(!nextChallenge.includes('Goal 1 must not add visual graph code nodes'), 'archived decisions stay out of future gates');
assert(nextChallenge.includes('Preflight output names affected routes'), 'new task criteria become live gates');
assert(nextChallenge.includes('Keep deploys versioned'), 'standing decisions still gate future work');

console.log('supervisor_doc_lifecycle.test ok');
