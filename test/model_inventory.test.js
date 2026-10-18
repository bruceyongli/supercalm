import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { scanProvider, discoverySeeds, fetchInventoryJson } from '../src/model_inventory.js';
import { applyCatalog, currentProviders, listProxyModels } from '../src/model_catalog.js';

const key = 'fixture-key-not-for-error-messages';
let mode = 'good', paths = [];
const server = createServer((req, res) => {
  paths.push(req.url);
  assert.equal(req.headers.authorization, `Bearer ${key}`);
  if (mode === 'timeout') return;
  if (mode === 'malformed') { res.end('{bad JSON'); return; }
  if (mode === 'invalid') { res.end(JSON.stringify({ data: [{ name: 'no-id' }] })); return; }
  if (mode === 'metadata') { res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5' }] })); return; }
  if (/^http/.test(mode) || (mode === 'legacy' && req.url.includes('?'))) {
    res.writeHead(mode === 'http401' ? 401 : 503); res.end(`private upstream details ${key}`); return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ data: mode === 'empty' ? [] : [{ id: mode === 'recovery' ? 'claude-opus-5-6' : 'claude-opus-5-5',
    recommended: true, supported_reasoning_efforts: ['high', 'max'], capabilities: { image_input: true } }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const seed = { proxy: 'claude', label: 'Claude', port: server.address().port, nativeFor: ['claude'],
  models: [{ id: 'claude-opus-4-8' }] };
try {
  const good = await scanProvider(seed, null, key);
  assert.deepEqual(paths, ['/v1/models?latest=1']);
  assert.deepEqual(good.models.map(m => m.id), ['claude-opus-5-5']);
  assert.deepEqual(good.models[0].efforts, ['high', 'max']);
  assert.equal(good.models[0].vision, true);
  assert.equal(good.reachable, true); assert.equal(good.stale, false);
  assert.ok(good.lastSuccessfulAt);
  assert.deepEqual(discoverySeeds([seed], [good]), [good], 'previous builtin discoveries replace static seeds');
  let prior = good;
  for (const failure of ['http503', 'http401', 'malformed', 'invalid', 'timeout']) {
    mode = failure; paths = [];
    const result = await scanProvider(prior, null, key, { timeoutMs: failure === 'timeout' ? 25 : 5000 });
    assert.deepEqual(paths, ['/v1/models?latest=1', '/v1/models']);
    assert.equal(result.up, true); assert.equal(result.reachable, false); assert.equal(result.stale, true);
    assert.ok(result.scanError); assert.equal(result.lastSuccessfulAt, good.lastSuccessfulAt);
    assert.deepEqual(result.models, prior.models); assert.deepEqual(result.recommended, good.recommended);
    assert.doesNotMatch(JSON.stringify(result), /fixture-key|private upstream/);
    assert.equal(applyCatalog(JSON.parse(JSON.stringify([result]))), true, 'restart round trip');
    assert.equal(currentProviders()[0].stale, true);
    assert.equal(currentProviders()[0].scanError, result.scanError);
    assert.deepEqual(listProxyModels({ liveOnly: true }).map(m => m.id), ['claude-opus-5-5'], 'transient failure cannot empty picker');
    prior = currentProviders()[0];
  }
  mode = 'http401';
  const absent = await scanProvider(seed, null, key);
  assert.equal(absent.up, false, 'never discovered provider does not become available');
  applyCatalog([absent]); assert.deepEqual(listProxyModels({ liveOnly: true }), []);
  const sparkSeed = { ...good, proxy: 'spark', aliases: { old: 'claude-opus-5-5' } };
  assert.deepEqual((await scanProvider(sparkSeed, null, key)).aliases, sparkSeed.aliases);
  mode = 'recovery';
  const recovered = await scanProvider(prior, null, key);
  assert.equal(recovered.stale, false); assert.equal(recovered.scanError, null); assert.equal(recovered.reachable, true);
  assert.deepEqual(recovered.models.map(m => m.id), ['claude-opus-5-6']);
  mode = 'empty';
  const empty = await scanProvider(recovered, null, key);
  assert.deepEqual(empty.models, []); assert.equal(empty.up, true);
  assert.equal(applyCatalog([empty]), true); assert.deepEqual(listProxyModels(), [], 'valid empty inventory removes previous models/pins');
  applyCatalog([{ ...empty, inventoryFilter: null }]);
  assert.deepEqual(listProxyModels(), [], 'successful bare empty inventory is authoritative too');
  mode = 'legacy'; paths = [];
  const legacy = await scanProvider(seed, null, key);
  assert.equal(legacy.inventoryFilter, null); assert.equal(legacy.reachable, true);
  assert.deepEqual(paths, ['/v1/models?latest=1', '/v1/models']);
  mode = 'metadata';
  assert.equal((await scanProvider(good, { models: {}, recommended: {} }, key)).models[0].id, 'claude-opus-5-5',
    'malformed optional overview metadata cannot discard a valid live inventory');
  const error = await fetchInventoryJson('http://example.invalid', key, { fetcher: async () => { throw new Error(key); } });
  assert.deepEqual(error, { error: 'Inventory connection failed' });
  console.log('model_inventory: latest, failures, retention, restart, recovery, empty inventory, legacy fallback PASS');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
