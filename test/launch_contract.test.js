import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-manifest-'));
const { writeManifest, readManifest, verifyResume } = await import('../src/launch_contract.js');

// round-trip + immutability stance
await writeManifest('s_m1', { tool: 'codex', autonomy: 'full', model: 'gpt-5.5', branch: 'b1', worktree_path: '/w/1' });
const m = await readManifest('s_m1');
assert.equal(m.tool, 'codex');
assert.ok(m.at > 0);
assert.equal(await readManifest('s_none'), null, 'missing manifest reads null (fail-open)');

// pre-manifest sessions: fail-open
assert.deepEqual(verifyResume(null, { tool: 'codex' }), { ok: true, restore: {}, mismatches: [] });

// the lost-flags incident: NULLed row values RESTORE from the manifest
const healed = verifyResume(m, { tool: 'codex', autonomy: null, model: '', branch: 'b1', worktree_path: '/w/1' }, { branch: 'b1' });
assert.equal(healed.ok, true);
assert.deepEqual(healed.restore, { autonomy: 'full', model: 'gpt-5.5' }, 'silently-lost flags heal from the manifest');

// deliberate row changes (non-null) are NOT overridden
const changed = verifyResume(m, { tool: 'codex', autonomy: 'ask', model: 'gpt-5.5', branch: 'b1', worktree_path: '/w/1' }, { branch: 'b1' });
assert.deepEqual(changed.restore, {}, 'the row stays authoritative for deliberate settings changes');

// identity drift refuses loudly
const drift = verifyResume(m, { tool: 'codex', worktree_path: '/w/other', branch: 'b1' }, { branch: 'b2' });
assert.equal(drift.ok, false);
assert.equal(drift.mismatches.length, 2, 'worktree + branch drift both named');
assert.equal(verifyResume(m, { tool: 'claude' }).ok, false, 'tool drift refuses');

console.log('launch_contract: all assertions passed');
