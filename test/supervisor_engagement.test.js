import assert from 'node:assert/strict';

const { TIERS, tierOf, tierThresholds, allowedWhenTier, tierReason, askExpired, askTtlMs, queueTier, QUEUE_TIER_ORDER } =
  await import('../src/agents/supervisor/engagement.js');

const H = 3600 * 1000;
const now = 1_800_000_000_000;
const th = { hotMs: 6 * H, warmMs: 48 * H };

// ---- tier boundaries ----
assert.deepEqual(TIERS, ['hot', 'warm', 'stale']);
assert.equal(tierOf({ lastTouch: now - 1 * H, now, thresholds: th }), 'hot');
assert.equal(tierOf({ lastTouch: now - 6 * H, now, thresholds: th }), 'hot', 'inclusive boundary');
assert.equal(tierOf({ lastTouch: now - 7 * H, now, thresholds: th }), 'warm');
assert.equal(tierOf({ lastTouch: now - 48 * H, now, thresholds: th }), 'warm', 'inclusive boundary');
assert.equal(tierOf({ lastTouch: now - 49 * H, now, thresholds: th }), 'stale');
assert.equal(tierOf({ lastTouch: 0, now, thresholds: th }), 'stale', 'never-touched (zombie) is stale');
assert.equal(tierOf({ now, thresholds: th }), 'stale', 'missing lastTouch is stale, never hot');

// ---- env threshold clamping ----
const t1 = tierThresholds({ AIOS_ENGAGEMENT_HOT_HOURS: '0.001', AIOS_ENGAGEMENT_WARM_HOURS: '0' });
assert.ok(t1.hotMs >= 10 * 60 * 1000, 'hot floor 10min');
assert.ok(t1.warmMs >= H, 'warm floor 1h');
const t2 = tierThresholds({});
assert.equal(t2.hotMs, 6 * H);
assert.equal(t2.warmMs, 48 * H);

// ---- permission matrix ----
for (const kind of ['answer', 'verify', 'nudge', 'recover', 'doc', 'learn']) {
  assert.equal(allowedWhenTier('hot', kind), true, `hot allows ${kind}`);
}
assert.equal(allowedWhenTier('warm', 'answer'), true);
assert.equal(allowedWhenTier('warm', 'recover'), true);
assert.equal(allowedWhenTier('warm', 'doc'), true);
assert.equal(allowedWhenTier('warm', 'nudge'), false, 'no idle pressure when the operator is away');
assert.equal(allowedWhenTier('warm', 'verify'), false, 'warm verify needs NEW WORK');
assert.equal(allowedWhenTier('warm', 'verify', { newWork: true }), true);
for (const kind of ['answer', 'verify', 'nudge', 'recover', 'doc']) {
  assert.equal(allowedWhenTier('stale', kind), false, `stale holds ${kind}`);
  assert.equal(allowedWhenTier('stale', kind, { newWork: true }), false, 'newWork never overrides stale');
}
assert.equal(allowedWhenTier('stale', 'learn'), true, 'operator messages still distill (they re-heat anyway)');
assert.equal(allowedWhenTier('bogus', 'verify'), true, 'unknown tier degrades to hot (never bricks supervision)');
assert.equal(tierReason('stale', 'verify'), 'tier-stale-holds-verify');

// ---- ask TTL ----
assert.equal(askExpired({ askedAt: now - 47 * H, now, ttlMs: 48 * H }), false);
assert.equal(askExpired({ askedAt: now - 49 * H, now, ttlMs: 48 * H }), true);
assert.equal(askExpired({ askedAt: 0, now, ttlMs: 48 * H }), true, 'missing timestamps expire');
assert.ok(askTtlMs({}) === 48 * H && askTtlMs({ AIOS_ASK_TTL_HOURS: '0.1' }) === H, 'TTL default + floor');

// ---- queue tiering ----
assert.equal(queueTier({ tier: 'hot', category: 'action' }), 'blocking');
assert.equal(queueTier({ tier: 'warm', category: 'action' }), 'blocking');
assert.equal(queueTier({ tier: 'stale', category: 'action' }), 'stale', 'stale never blocks');
assert.equal(queueTier({ tier: 'hot', category: 'decision' }), 'fresh');
assert.equal(queueTier({ tier: 'warm', category: 'review' }), 'fresh');
assert.equal(queueTier({ tier: 'stale', category: 'review' }), 'stale');
assert.ok(QUEUE_TIER_ORDER.blocking < QUEUE_TIER_ORDER.fresh && QUEUE_TIER_ORDER.fresh < QUEUE_TIER_ORDER.stale);

// ---- integration locks: the governor's gates must stay wired (source-level, like the architecture contract) ----
{
  const { readFileSync } = await import('node:fs');
  const sup = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
  assert.match(sup, /engagementTierFor\(ctx, s, t\)/, 'onTick computes the tier');
  assert.match(sup, /tier === 'stale'/, 'stale detection-only gate exists');
  assert.match(sup, /reconcileZombieSupervisors/, 'boot reconcile disables zombie grants');
  assert.ok(sup.split("allowedWhenTier(tier, 'nudge')").length >= 4, 'keepworking + unstick + checkpoint are tier-gated');
  assert.match(sup, /allowedWhenTier\(tier, 'verify', \{ newWork: st\.tierVerifiedFp !== fp\.work \}\)/, 'warm verify is new-work-only');
  const srv = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(srv, /queueTier\(\{ tier: s\.tier, category: s\.category \}\)/, 'queue rows carry the tier');
  assert.match(srv, /QUEUE_TIER_ORDER/, 'queue is tier-sorted');
  const sess = readFileSync(new URL('../src/sessions.js', import.meta.url), 'utf8');
  assert.match(sess, /expireStaleAsks/, 'ask TTL sweep wired');
}

console.log('supervisor_engagement.test ok');
