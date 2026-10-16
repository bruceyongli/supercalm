import assert from 'node:assert/strict';
import { applyCatalog, defaultToolModel, toolModels, routeForModel } from '../src/model_catalog.js';
import { TOOLS } from '../src/config.js';
import { defaultEffortForModel } from '../src/model_efforts.js';
import { groupedModelOptions } from '../web/model-select.js';

const claude = models => ({ proxy: 'claude', label: 'Claude', port: 8789, nativeFor: ['claude'],
  inventoryFilter: 'latest', recommended: ['claude-haiku-5-5', 'claude-opus-5'], models });
applyCatalog([
  claude([
    { id: 'claude-haiku-5-5', recommended: true },
    { id: 'claude-opus-5', label: 'Claude Opus 5', recommended: true },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-opus-5-5-20261001', label: 'Claude Opus 5.5' },
    { id: 'claude-fable-6', recommended: true },
  ]),
  { proxy: 'codex', label: 'Codex', port: 8788, nativeFor: ['codex'], inventoryFilter: 'latest',
    recommended: ['gpt-6.1-sol', 'gpt-6-astra'], models: [
      { id: 'gpt-6-sol' }, { id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    ] },
]);
assert.equal(defaultToolModel('claude'), 'claude-opus-5-5', 'catalog recommendation order cannot choose Haiku or older Opus');
assert.equal(TOOLS.claude.model, 'claude-opus-5-5');
assert.equal(routeForModel('opus').model, 'claude-opus-5-5', 'friendly alias follows the same newest family');
const options = toolModels('claude');
assert.ok(options.some(m => m.id === 'claude-opus-5-5'), 'exact launch default is a real option, not custom text');
const html = groupedModelOptions(options, { selected: TOOLS.claude.model });
assert.match(html, /value="claude-opus-5-5" selected/);
assert.doesNotMatch(html, /custom/);
assert.equal((html.match(/>Opus 5\.5 \(vision\)<\/option>/g) || []).length, 1, 'friendly alias and concrete default stay visually deduplicated');
assert.equal(TOOLS.codex.model, 'gpt-6.1-sol');
assert.equal(defaultEffortForModel('codex', TOOLS.codex.model), 'xhigh');

applyCatalog([claude([
  { id: 'claude-opus-5-9', recommended: true },
  { id: 'claude-opus-5-10-20261001' },
  { id: 'claude-opus-5-10' },
  { id: 'claude-opus-99', kind: 'image' },
])]);
assert.equal(TOOLS.claude.model, 'claude-opus-5-10', 'future versions advance numerically without editing config');
assert.equal(routeForModel('opus').model, 'claude-opus-5-10');
process.env.AIOS_CLAUDE_MODEL = 'claude-operator-pin';
assert.equal(TOOLS.claude.model, 'claude-operator-pin', 'deliberate administrator overrides remain honored');
delete process.env.AIOS_CLAUDE_MODEL;
console.log('launch_defaults: newest Opus, live Codex flagship/xhigh, numeric versions, alias dedupe and explicit override passed');
