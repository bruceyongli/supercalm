import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-caps-'));

const { mintCapability, consumeCapability, getCapability } = await import('../src/capabilities.js');

// ---- authority provenance: only operator acts mint; LLM paraphrases are unrepresentable ----
assert.throws(() => mintCapability({ action: 'deploy', mintedBy: 'supervisor' }), /operator act/);
assert.throws(() => mintCapability({ action: 'deploy', mintedBy: 'agent:supervisor' }), /operator act/);
assert.throws(() => mintCapability({ mintedBy: 'operator_tap' }), /action class/);

// ---- mint + single consume + exhaustion ----
const cap = mintCapability({ sessionId: 's_x', action: 'deploy', mintedBy: 'operator_tap' });
assert.equal(cap.uses_left, 1);
const used = consumeCapability({ sessionId: 's_x', action: 'deploy', scopeText: 'run bin/deploy now' });
assert.ok(used, 'live capability authorizes');
assert.equal(used.uses_left, 0);
assert.equal(consumeCapability({ sessionId: 's_x', action: 'deploy' }), null, 'single-use: second consume refused');
assert.equal(JSON.parse(getCapability(cap.id).consumed_log).length, 1, 'consumption is logged');

// ---- scope pinning: a sha-scoped capability only covers text containing that sha ----
mintCapability({ sessionId: 's_y', action: 'deploy', scope: 'abc1234', mintedBy: 'operator_message:m_42' });
assert.equal(consumeCapability({ sessionId: 's_y', action: 'deploy', scopeText: 'deploy def9999' }), null, 'out-of-scope refused');
assert.ok(consumeCapability({ sessionId: 's_y', action: 'deploy', scopeText: 'deploy abc1234 to prod' }), 'pinned scope matches');

// ---- session isolation + expiry ----
mintCapability({ sessionId: 's_a', action: 'credentials', mintedBy: 'operator_tap' });
assert.equal(consumeCapability({ sessionId: 's_b', action: 'credentials' }), null, 'another session cannot spend it');
const short = mintCapability({ sessionId: 's_t', action: 'survey', mintedBy: 'operator_tap', ttlMs: 1 });
await new Promise((r) => setTimeout(r, 10));
assert.equal(consumeCapability({ sessionId: 's_t', action: 'survey' }), null, 'expired capability never authorizes');
assert.ok(short.expires_at - short.created_at <= 60 * 60_000, 'TTL is hard-capped');

// ---- wrong action class never matches ----
mintCapability({ sessionId: 's_z', action: 'deploy', mintedBy: 'operator_tap' });
assert.equal(consumeCapability({ sessionId: 's_z', action: 'git_destructive' }), null, 'class is exact');

console.log('capabilities: all assertions passed');
