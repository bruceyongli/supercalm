import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAgyModels } from '../src/auth/agy_cli.js';
import {
  parseClaudeModelsCache,
  parseCodexModels,
  parseCodexModelsCache,
} from '../src/cli_model_discovery.js';
import {
  applyCatalog,
  listProxyModels,
  modelSupportsFast,
  toolModels,
} from '../src/model_catalog.js';

const codex = parseCodexModels([
  {
    id: 'gpt-next',
    model: 'gpt-next',
    displayName: 'GPT-Next-Sol',
    hidden: false,
    isDefault: true,
    serviceTiers: [{ id: 'priority', name: 'Fast' }],
    inputModalities: ['text', 'image'],
  },
  { id: 'hidden', model: 'hidden', displayName: 'Hidden', hidden: true },
]);
assert.deepEqual(codex.map((model) => model.id), ['gpt-next']);
assert.equal(codex[0].label, 'GPT Next Sol');
assert.equal(codex[0].supportsFast, true);
assert.equal(codex[0].vision, true);

const cached = parseCodexModelsCache({
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      visibility: 'list',
      priority: 1,
      additional_speed_tiers: ['fast'],
      input_modalities: ['text', 'image'],
    },
    { slug: 'internal', visibility: 'hide', priority: 2 },
  ],
});
assert.deepEqual(cached.map((model) => model.id), ['gpt-5.6-sol']);
assert.equal(cached[0].label, 'GPT-5.6 Sol');
assert.equal(cached[0].supportsFast, true);

assert.deepEqual(parseClaudeModelsCache({
  baseUrl: 'http://127.0.0.1:8793/api/cli-proxy',
  models: [{ id: 'feedback-loop' }],
}), [], 'AIOS-generated Claude gateway cache cannot feed back into discovery');
assert.deepEqual(parseClaudeModelsCache({
  baseUrl: 'https://subscription-gateway.example',
  models: [{ id: 'claude-future', display_name: 'Claude Future' }],
}).map((model) => model.id), ['claude-future']);

assert.deepEqual(parseAgyModels('model-a\nmodel-b\nmodel-a\n'), ['model-a', 'model-b']);

applyCatalog([
  {
    proxy: 'codex',
    label: 'Codex',
    port: 8788,
    nativeFor: ['codex'],
    up: false,
    models: [
      { id: 'gpt-one', label: 'GPT One', supportsFast: true, vision: true },
      { id: 'gpt-two', label: 'GPT Two' },
      { id: 'gpt-three', label: 'GPT Three', vision: false },
      { id: 'whisper-test', label: 'Whisper Test', kind: 'utility' },
    ],
  },
], { source: 'test' });
const listing = listProxyModels().find((model) => model.id === 'gpt-one');
assert.equal(listing.supportsFast, true, 'CLI capability metadata survives catalog normalization');
assert.equal(listing.vision, true);
assert.equal(listProxyModels().find((model) => model.id === 'gpt-three').vision, false, 'an explicit CLI text-only capability outranks provider defaults');
assert.equal(modelSupportsFast('gpt-one'), true);
assert.ok(toolModels('codex').some((model) => model.id === 'gpt-three'), 'subscription selectors list the complete discovered catalog');
assert.ok(!listProxyModels({ includeImages: true }).some((model) => model.id === 'whisper-test'), 'voice utility endpoints never leak into model selectors');

const scanSource = readFileSync(new URL('../src/model_scan.js', import.meta.url), 'utf8');
const cliAt = scanSource.indexOf('await discoverCliModels()');
const apiAt = scanSource.indexOf('await refreshProviderModels()');
const fleetAt = scanSource.indexOf('await scanCatalog()');
assert.ok(cliAt > 0 && cliAt < apiAt && apiAt < fleetAt, 'refresh precedence is CLI → API provider → fleet');
assert.match(scanSource, /rescanInFlight/, 'automated/manual scans are single-flight');
assert.match(scanSource, /AIOS_MODEL_RESCAN_MS \|\| 3600_000/, 'automatic discovery repeats hourly by default');

console.log('model_discovery.test ok');
