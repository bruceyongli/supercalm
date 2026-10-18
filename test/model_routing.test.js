import assert from 'node:assert/strict';
import { applyCatalog, assertModelRoute, routeForModel, registerUserRoutes, modelDisplayLabel } from '../src/model_catalog.js';
import { callProxyModel } from '../src/agents/model.js';
import { anthropicHeaders } from '../src/anthropic_headers.js';

const agy = { proxy: 'antigravity', port: 8791, models: [{ id: 'claude-opus-5-5' }, { id: 'gpt-6.1-sol' },
  { id: 'gemini-current' }, { id: 'gpt-oss-120b-medium' }, { id: 'claude-opus-4-6-thinking' }] };
const claude = { proxy: 'claude', port: 8789, inventoryFilter: 'latest', models: [{ id: 'claude-opus-5-5' }] };
const codex = { proxy: 'codex', port: 8788, inventoryFilter: 'latest', models: [{ id: 'gpt-6.1-sol' }] };
for (const providers of [[agy, claude, codex], [claude, codex, agy]]) {
  applyCatalog(providers);
  assert.equal(routeForModel('claude-opus-5-5').port, 8789, 'native owner wins duplicates in either catalog order');
  assert.equal(routeForModel('gpt-6.1-sol').port, 8788);
  assert.equal(routeForModel('claude-opus-99').port, 8789, 'new model before discovery keeps its native endpoint');
  assert.equal(routeForModel('gpt-99').port, 8788);
  assert.equal(routeForModel('opus').model, 'claude-opus-5-5');
  assert.equal(routeForModel('gemini-current').port, 8791);
  assert.equal(routeForModel('gpt-oss-120b-medium').port, 8791, 'GPT-OSS is not a Codex subscription model');
  assert.equal(routeForModel('claude-opus-4-6-thinking').port, 8791, 'synthetic fleet variants keep their advertised route');
  assert.equal(routeForModel('antigravity/claude-opus-5-5').port, 8791, 'explicit provider override preserved');
}
applyCatalog([agy, { ...claude, models: [] }, { ...codex, models: [] }]);
assert.equal(routeForModel('claude-opus-5-5').port, 8789, 'AGY-only discovery cannot redirect bare Claude IDs');
assert.equal(routeForModel('gpt-6.1-sol').port, 8788);
applyCatalog([agy]);
assert.equal(routeForModel('claude-opus-5-5').unresolved, true, 'disabled native provider cannot fall through to AGY');
registerUserRoutes([{ id: 'claude-opus-5-5', providerLabel: 'Custom', proxy: 'api', base: 'https://provider.invalid/v1', model: 'explicit-model' }]);
assert.equal(routeForModel('claude-opus-5-5').model, 'explicit-model');
assert.equal(routeForModel('custom/claude-opus-5-5').model, 'explicit-model');
assert.equal(assertModelRoute(routeForModel('claude-opus-5-5')).proxy, 'api');
registerUserRoutes([]);
const unknown = routeForModel('not-discovered');
assert.equal(unknown.unresolved, true); assert.equal(unknown.port, null);
assert.equal(modelDisplayLabel('not-discovered'), 'not-discovered', 'saved unknown IDs remain safe for history rendering');
assert.throws(() => assertModelRoute(unknown), { code: 'unknown_model_route', status: 400 });
await assert.rejects(callProxyModel(unknown, []), { code: 'unknown_model_route' });

const body = { context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] } };
const before = JSON.stringify(body);
assert.deepEqual(anthropicHeaders({}, {}), { 'anthropic-version': '2023-06-01', 'anthropic-beta': '' });
assert.equal(anthropicHeaders({}, body)['anthropic-beta'], 'context-management-2025-06-27');
const supplied = { 'anthropic-version': 'future-version', 'anthropic-beta': 'tools-beta, tools-beta,custom-beta' };
const suppliedBefore = JSON.stringify(supplied);
assert.deepEqual(anthropicHeaders(supplied, body), { 'anthropic-version': 'future-version',
  'anthropic-beta': 'tools-beta,custom-beta,context-management-2025-06-27' });
assert.equal(anthropicHeaders({ 'anthropic-beta': 'context-management-2026-01-01' }, body)['anthropic-beta'], 'context-management-2026-01-01');
assert.equal(anthropicHeaders({ 'anthropic-beta': 'context-management-2025-06-27' }, body)['anthropic-beta'], 'context-management-2025-06-27');
assert.equal(JSON.stringify(body), before); assert.equal(JSON.stringify(supplied), suppliedBefore);
console.log('model_routing: native ownership, no implicit cross-provider fallback, explicit routes, Anthropic beta headers PASS');
