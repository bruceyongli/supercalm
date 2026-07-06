import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dodFiles, findDoD } from '../src/agents/spec_files.js';

const root = await mkdtemp(join(tmpdir(), 'aios-supervisor-spec-'));
const specDir = join(root, 'openhand', 'docs', 'specs');
await mkdir(specDir, { recursive: true });
await mkdir(join(root, 'docs', 'verify-2026-06-24'), { recursive: true });
await mkdir(join(root, 'openhand', 'docs'), { recursive: true });

await writeFile(
  join(specDir, 'ai-employee-harness-implementation-contract.md'),
  [
    '# AI Employee Harness Implementation Contract',
    '## Implementation Goal 1 - Durable Harness Core',
    'Goal 1 details.',
    'x'.repeat(6000),
    '## Implementation Goal 2 - AI Supervisor Approval Delegation',
    '- Supervisor role exists and is visibly distinct from worker roles.',
    '- Approval requests can be assigned to an AI Supervisor.',
  ].join('\n')
);
await writeFile(
  join(root, 'openhand', 'docs', 'CURRENT_ACCEPTANCE_CONTRACT.md'),
  '# Current Acceptance Contract\n\nThis is an unrelated active contract.'
);
await writeFile(
  join(specDir, 'digital-employee-platform-architecture.md'),
  '# Digital Employee Platform Architecture\n\nn8n is a template source/importer only; Hermes plus the in-house graph model is the runtime.'
);
await mkdir(join(root, 'openhand', 'docs', 'architecture'), { recursive: true });
await writeFile(
  join(root, 'openhand', 'docs', 'architecture', 'ARCHITECTURE.md'),
  '# Compx Architecture\n\nUnrelated manifest engine decision.'
);
await writeFile(join(root, 'docs', 'verify-2026-06-24', 'fake-contract.md'), '# stale evidence');

const files = dodFiles(root, { query: 'ai-employee-harness-implementation-contract.md' });
assert.equal(files[0].name, 'openhand/docs/specs/ai-employee-harness-implementation-contract.md');
assert.equal(files.length, 1);
assert(!files.some((f) => f.name.includes('verify-2026-06-24')));

const dod = findDoD(root, { query: 'ai-employee-harness-implementation-contract.md' });
assert.deepEqual(dod.files, ['openhand/docs/specs/ai-employee-harness-implementation-contract.md']);
assert(dod.files.includes('openhand/docs/specs/ai-employee-harness-implementation-contract.md'));
assert(!dod.files.some((f) => f.includes('verify-2026-06-24')));
assert(dod.text.includes('Implementation Goal 2 - AI Supervisor Approval Delegation'));
assert(dod.text.includes('Approval requests can be assigned to an AI Supervisor'));

const architectureDod = findDoD(root, { query: 'openhand/docs/specs/digital-employee-platform-architecture.md' });
assert.deepEqual(architectureDod.files, ['openhand/docs/specs/digital-employee-platform-architecture.md']);
assert(architectureDod.text.includes('n8n is a template source/importer only'));
assert(!architectureDod.text.includes('Unrelated manifest engine decision'));

console.log('supervisor_spec_files.test ok');
