// LAUNCH PROFILE CONTRACT — born from the 2026-08-11 fleet outage, in which every relaunched
// session was bricked by two compounding launch-path regressions:
//   (a) an exec-level sandbox-exec wrapper around the tool argv — macOS seatbelt cannot nest, so
//       codex (which applies its own profile in workspace-write) died on every command with
//       `sandbox_apply: Operation not permitted`, and claude broke on home-root config writes;
//   (b) autonomy=full silently downgraded to workspace-write for isolated (worktree) sessions.
// Operator directive: Full means full, launches are never exec-wrapped, and each tool's default
// model follows the live catalog instead of a stale hardcode. This suite pins all three.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = process.env.AIOS_DATA || mkdtempSync(join(tmpdir(), 'aios-launch-profile-'));
delete process.env.AIOS_CODEX_MODEL;
delete process.env.AIOS_CLAUDE_MODEL;
delete process.env.AIOS_AGY_MODEL;

const { TOOLS } = await import('../src/config.js');
const { applyCatalog, defaultToolModel } = await import('../src/model_catalog.js');

// --- 1. Autonomy → flags: full is FULL (fresh + resume, worktree or not); auto stays confined ---
for (const isolated of [false, true]) {
  const full = TOOLS.codex.argv('task', { autonomy: 'full', isolated });
  assert.equal(full[0], 'codex', 'argv[0] is the tool binary — launches are NEVER exec-wrapped');
  assert.ok(full.includes('--dangerously-bypass-approvals-and-sandbox'), `full (isolated=${isolated}) carries the real bypass`);
  assert.ok(!full.includes('workspace-write'), 'full never starts an inner seatbelt (it cannot nest under a wrapper)');

  const fullResume = TOOLS.codex.argv('', { autonomy: 'full', isolated, resume: true, resumeId: 'u-u-i-d' });
  assert.equal(fullResume[0], 'codex');
  assert.ok(fullResume.includes('sandbox_mode=danger-full-access'), `resume keeps full genuinely full (isolated=${isolated})`);
  assert.ok(fullResume.includes('approval_policy=never'));
  assert.ok(!fullResume.includes('sandbox_mode=workspace-write'));

  const auto = TOOLS.codex.argv('task', { autonomy: 'auto', isolated });
  assert.deepEqual(auto.slice(auto.indexOf('-a'), auto.indexOf('-a') + 4), ['-a', 'never', '-s', 'workspace-write'],
    'auto remains the no-approval, workspace-confined tier');
  const autoResume = TOOLS.codex.argv('', { autonomy: 'auto', isolated, resume: true, resumeId: 'u-u-i-d' });
  assert.ok(autoResume.includes('sandbox_mode=workspace-write'));
}
const ask = TOOLS.codex.argv('task', { autonomy: 'ask' });
assert.ok(!ask.includes('--dangerously-bypass-approvals-and-sandbox') && !ask.includes('workspace-write'),
  'ask leaves the CLI to its own defaults and prompts');

const claudeFull = TOOLS.claude.argv('task', { autonomy: 'full' });
assert.equal(claudeFull[0], 'claude', 'claude argv is never exec-wrapped');
assert.ok(claudeFull.includes('--dangerously-skip-permissions'));
const agyFull = TOOLS.agy.argv('task', { autonomy: 'full' });
assert.equal(agyFull[0], 'agy', 'agy argv is never exec-wrapped');
assert.ok(agyFull.includes('--dangerously-skip-permissions'));

// --- 2. Default models follow the catalog, newest flagship first ---
assert.equal(defaultToolModel('codex'), 'gpt-5.6-sol', 'static seed: the newest recommended codex flagship leads');
assert.equal(TOOLS.codex.model, 'gpt-5.6-sol');
assert.equal(defaultToolModel('claude'), 'claude-fable-5', 'static seed: claude default follows the seed catalog head');
assert.equal(TOOLS.claude.model, 'claude-fable-5');
assert.equal(defaultToolModel('agy'), 'gemini-pro-agent');
assert.equal(TOOLS.agy.model, 'gemini-pro-agent');

// A fresh scan with a newer generation flips the defaults with no code change — including past an
// operator pin (pins guarantee availability; they must not freeze the default on an old pick).
applyCatalog([
  {
    proxy: 'codex', label: 'Codex', port: 8788, nativeFor: ['codex'],
    recommended: ['gpt-9-nova', 'gpt-5.6-sol'],
    models: [
      { id: 'codex-auto-review', label: 'Codex auto-review', role: 'code review' },
      { id: 'gpt-9-nova', label: 'GPT-9 Nova', recommended: true },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', recommended: true },
    ],
  },
  {
    proxy: 'claude', label: 'Claude', port: 8789, nativeFor: ['claude'],
    recommended: ['claude-omega-6'],
    models: [
      { id: 'claude-omega-6', label: 'Claude Omega 6', recommended: true },
      { id: 'claude-fable-5', label: 'Claude Fable 5', recommended: true },
    ],
  },
], { scannedAt: '2026-08-11T00:00:00.000Z', source: 'test' });

assert.equal(TOOLS.codex.model, 'gpt-9-nova', 'a newly-scanned flagship becomes the default with no code change');
assert.equal(TOOLS.codex.modelLabel, 'GPT-9 Nova', 'the label follows the live default');
assert.equal(TOOLS.claude.model, 'claude-omega-6');
assert.notEqual(defaultToolModel('codex'), 'codex-auto-review', 'role/utility entries can never become a default');
assert.equal(TOOLS.agy.model, 'gemini-pro-agent', 'a provider missing from the scan falls back to the literal default');

process.env.AIOS_CODEX_MODEL = 'gpt-operator-pin';
assert.equal(TOOLS.codex.model, 'gpt-operator-pin', 'an env pin outranks the catalog');
delete process.env.AIOS_CODEX_MODEL;

console.log('launch_autonomy_profile.test ok');
