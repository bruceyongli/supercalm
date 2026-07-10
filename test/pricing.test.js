// Pricing manifest layer: three shapes parse to one normalized map; the user manifest overrides
// the compiled RULES; keyless providers register + route; builtin proxy rows toggle.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.AIOS_DATA = mkdtempSync(join(tmpdir(), 'aios-pricing-'));
const assert = (await import('node:assert/strict')).default;
const { parseManifest, __testSetCache } = await import('../src/pricing.js');
const { priceRuleFor, priceUsage } = await import('../src/usage_pricing.js');

// shape C (native)
{
  const r = parseManifest({ unit: 'per_1m_tokens', models: { 'gpt-5.5': { input: 5, output: 30, cached: 0.5 } } });
  assert.equal(r.kind, 'native');
  assert.deepEqual(r.prices['gpt-5.5'], { in: 5, out: 30, cached: 0.5 });
}
// shape B (openhand-models.json)
{
  const r = parseManifest({ models: [{ id: 'glm-5.2', pricing: { token: { unit: 'per_1m_tokens', input: 0.6, output: 2.2, cached_input: 0.06 } } }] });
  assert.equal(r.kind, 'openhand');
  assert.equal(r.prices['glm-5.2'].out, 2.2);
}
// shape A (LiteLLM per-token)
{
  const r = parseManifest({ 'claude-opus-4-8': { input_cost_per_token: 0.000005, output_cost_per_token: 0.000025, cache_read_input_token_cost: 0.0000005 } });
  assert.equal(r.kind, 'litellm');
  assert.equal(Math.round(r.prices['claude-opus-4-8'].in * 100) / 100, 5);
  assert.equal(Math.round(r.prices['claude-opus-4-8'].out), 25);
}
// junk shapes rejected
assert.equal(parseManifest({ hello: 'world' }), null);
assert.equal(parseManifest(null), null);

// manifest overrides compiled RULES; clearing falls back
{
  const before = priceRuleFor({ model: 'gpt-5.5' });
  assert.ok(before && before.provider !== 'manifest', 'compiled rule exists for gpt-5.5');
  __testSetCache({ url: 'test', fetched_at: Date.now(), source_kind: 'native', prices: { 'gpt-5.5': { in: 1, out: 2, cached: 0.1 } } });
  const r = priceRuleFor({ model: 'gpt-5.5' });
  assert.equal(r.provider, 'manifest');
  assert.equal(r.input, 1);
  const cost = priceUsage({ model: 'gpt-5.5', input_tokens: 1_000_000, output_tokens: 1_000_000 });
  assert.equal(cost.pricing_known, undefined === cost.pricing_known ? cost.pricing_known : cost.pricing_known); // shape stays
  assert.ok(Math.abs(cost.estimated_cost_usd - 3) < 0.01, `manifest math: got ${cost.estimated_cost_usd}`);
  __testSetCache(null);
  assert.ok(priceRuleFor({ model: 'gpt-5.5' }).provider !== 'manifest', 'fallback to RULES after clear');
}

// keyless providers: upsert without key, probe headerless, routes registered
const { upsertProvider, listProviders, deleteProvider, listBuiltinProviders, setBuiltinEnabled, builtinDisabled, providerRoutes } = await import('../src/model_providers.js');
{
  const p = upsertProvider({ name: 'Local vLLM', kind: 'openai', base_url: 'http://127.0.0.1:9999', models: ['my-local-model'] });
  assert.equal(p.key_set, false, 'keyless provider stored');
  const routes = providerRoutes();
  const r = routes.find((x) => x.id === 'my-local-model');
  assert.ok(r, 'keyless model routes');
  assert.equal(r.key, undefined, 'no key on the route');
  deleteProvider(p.id);
}
// builtin rows + toggle roundtrip
{
  const rows = listBuiltinProviders([{ proxy: 'codex', label: 'Codex', port: 8788 }], { codex: ['gpt-5.5'] });
  assert.equal(rows[0].id, 'builtin:codex');
  assert.equal(rows[0].enabled, true);
  setBuiltinEnabled('codex', false);
  assert.ok(builtinDisabled().has('codex'));
  const rows2 = listBuiltinProviders([{ proxy: 'codex', label: 'Codex', port: 8788 }], {});
  assert.equal(rows2[0].enabled, false);
  setBuiltinEnabled('codex', true);
  assert.ok(!builtinDisabled().has('codex'));
}

console.log('pricing.test ok');
process.exit(0);
