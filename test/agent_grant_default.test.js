// Implied-consent grants must not disable default-ON agents (operator-visible 2026-08-12: opening
// the Council panel once made Council vanish from the agent tab strip). Mechanism: running any
// action on a not-yet-granted agent auto-creates its grant row for the low-risk caps, and
// upsertGrant's new-row default is enabled=false — while viewAgent treats ANY grant row as
// authoritative over meta.defaultEnabled. So the implied grant silently flipped preflight/knowledge
// from default-enabled to inactive. The fix: the implied grant carries `enabled: !!meta.defaultEnabled`.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-grant-default-'));
const store = await import('../src/store.js');

// upsertGrant semantics (the sharp edge this fix works around): a NEW row without an explicit
// `enabled` lands disabled — that is by design for consent, so the caller must pass the default.
store.upsertGrant('s_g1', 'someagent', { caps: ['read-context'] });
assert.equal(store.getGrant('s_g1', 'someagent').enabled, false, 'a bare implied grant would land disabled');
store.upsertGrant('s_g2', 'someagent', { enabled: true, caps: ['read-context'] });
assert.equal(store.getGrant('s_g2', 'someagent').enabled, true, 'passing enabled:true keeps the agent on');
// And an existing explicit OFF is respected by a later caps-only patch (no accidental re-enable).
store.upsertGrant('s_g2', 'other', { enabled: false });
store.upsertGrant('s_g2', 'other', { caps: ['read-context'] });
assert.equal(store.getGrant('s_g2', 'other').enabled, false, 'caps-only patches never flip an explicit OFF back on');

// Pin the call site: the agents host's implied-consent grant must carry the agent's defaultEnabled.
const hostSrc = readFileSync(new URL('../src/agents/host.js', import.meta.url), 'utf8');
assert.match(hostSrc, /upsertGrant\(gid, agentId, \{ enabled: !!rec\.meta\.defaultEnabled, caps: declared\.filter/,
  'the implied-consent grant preserves defaultEnabled (a default-ON agent must not vanish from the strip after first use)');

console.log('agent_grant_default.test ok');
