import assert from 'node:assert/strict';
import { applyCatalog, routeForModel, listProxyModels, registerUserRoutes } from '../src/model_catalog.js';

const current = 'qwen38-flash-next-nvfp4';
const legacy = ['qwen36-a3b-nvfp4-marlin', 'qwen36-a3b',
  'RedHatAI/Qwen3.6-35B-A3B-NVFP4', 'Qwen/Qwen3.6-35B-A3B'];
const providers = [
  { proxy: 'antigravity', port: 8791, models: [{ id: 'unrelated-model' }] },
  { proxy: 'spark', port: 8792, inventoryFilter: 'latest',
    models: [{ id: current, vision: true }, { id: 'openai/whisper-large-v3-turbo', kind: 'utility' }],
    aliases: { ...Object.fromEntries(legacy.map((id) => [id, current])), broken: 'missing-model' } },
];
// JSON round trip also covers persisted-catalog restoration.
assert.equal(applyCatalog(JSON.parse(JSON.stringify(providers))), true);
for (const id of legacy) {
  const route = routeForModel(id);
  assert.equal(route.proxy, 'spark');
  assert.equal(route.port, 8792);
  assert.equal(route.model, current);
}
const listed = listProxyModels();
assert.ok(listed.some((model) => model.id === current && model.vision));
assert.ok(!listed.some((model) => legacy.includes(model.id)), 'routing aliases must not reappear in pickers');
assert.equal(routeForModel('spark:qwen36-a3b').proxy, 'spark');
assert.equal(routeForModel('openai/whisper-large-v3-turbo').model, 'openai/whisper-large-v3-turbo');
assert.equal(routeForModel('broken').proxy, 'antigravity', 'missing targets are not advertised as working aliases');
assert.equal(routeForModel('unknown-model').proxy, 'antigravity');
registerUserRoutes([{ id: legacy[0], proxy: 'user-defined', model: 'user-model', port: 9000 }]);
assert.equal(routeForModel(legacy[0]).proxy, 'user-defined', 'explicit user routes keep priority');
registerUserRoutes([]);
console.log('spark_model_migration: all assertions passed');
