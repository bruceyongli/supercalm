import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildVoiceSourcePack,
  extractVoiceSourceReferences,
  splitVoiceSourceSections,
  voiceSourceContext,
  voiceSourceSummary,
} from '../src/voice_sources.js';

const refs = extractVoiceSourceReferences(`
The report includes [the compiler plan](/approved/compiler.md) and
/approved/audit-result.md. Ignore https://example.com/remote.md, image.png, and /private/secrets.env.
`);
assert.deepEqual(refs.map((ref) => ref.target), ['/approved/compiler.md', '/approved/audit-result.md']);
assert.equal(refs[0].label, 'the compiler plan');

const sections = splitVoiceSourceSections('# Plan\nIntro.\n\n## Compiler\nCompile policy graphs.\n\n## Coverage\nFive of seventy-two families are validated.', 'Plan');
assert.deepEqual(sections.map((section) => section.heading), ['Plan', 'Compiler', 'Coverage']);

const root = await mkdtemp(join(tmpdir(), 'aios-voice-sources-'));
const compiler = join(root, 'compiler.md');
const audit = join(root, 'audit.md');
await writeFile(compiler, `# Anchored Evidence Compiler

## Method
Model evidence anchors only. A deterministic proof closure checks them, then an immutable policy compiler owns the action graph.

## Next modules
Build a JSON policy and proof DSL, compiler and validator, curriculum generator, source adapters, and a coverage dashboard.
`);
await writeFile(audit, `# Canonical Audit

## Result
The approach replicated across five validated families.

## Limitation
Only five of seventy-two families are validated. Exact production compatibility is not yet established.
`);

const approved = new Map([
  ['/approved/compiler.md', compiler],
  ['/approved/audit-result.md', audit],
]);
const resolved = [];
const pack = await buildVoiceSourcePack({
  session: { id: 's_source' },
  reportText: '[Compiler plan](/approved/compiler.md)\n[Audit result](/approved/audit-result.md)\n[Secret](/private/secret.md)',
  resolveFile: async (_session, target) => {
    resolved.push(target);
    return approved.has(target) ? { target: approved.get(target), scope: 'test' } : null;
  },
});
assert.equal(pack.sources.length, 2, 'only resolver-approved linked documents enter voice context');
assert.deepEqual(voiceSourceSummary(pack), { count: 2, names: ['Compiler plan', 'Audit result'] });
assert.deepEqual(resolved, ['/approved/compiler.md', '/approved/audit-result.md', '/private/secret.md']);

const broad = voiceSourceContext(pack, 'Can you tell me the details of the plan?');
assert.match(broad, /deterministic proof closure/i);
assert.match(broad, /five of seventy-two/i, 'a broad walkthrough represents every linked source, including limitations');
const targeted = voiceSourceContext(pack, 'What are the curriculum modules?');
assert.match(targeted, /curriculum generator/i);
assert.doesNotMatch(targeted, /private\/secret|\/approved\//, 'source context contains titles and content, never filesystem paths');

console.log('voice_sources.test ok');
