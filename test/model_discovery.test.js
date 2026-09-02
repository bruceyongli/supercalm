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
  defaultToolModel,
  listProxyModels,
  modelSupportsFast,
  routeForModel,
  topProviderModels,
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
const latestFleetAt = scanSource.indexOf('/v1/models?latest=1');
const bareFleetAt = scanSource.indexOf('/v1/models`, key', latestFleetAt);
assert.ok(latestFleetAt > 0 && bareFleetAt > latestFleetAt,
  'fleet discovery requests the proxy-owned latest-family view first and keeps a legacy bare fallback');

applyCatalog([{
  proxy: 'claude',
  label: 'Claude',
  port: 8789,
  nativeFor: ['claude'],
  up: true,
  inventoryFilter: 'latest',
  models: [
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', recommended: true },
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
  ],
}], { source: 'test-latest' });
const latestClaude = toolModels('claude');
assert.ok(latestClaude.some((model) => model.id === 'claude-fable-5-1'));
assert.ok(!latestClaude.some((model) => model.id === 'claude-fable-5'),
  'an authoritative latest inventory cannot resurrect the superseded Fable line from static pins');
assert.equal(latestClaude.find((model) => model.id === 'opus')?.modelLabel, 'Claude Opus 5',
  'the friendly Claude family alias follows the newest advertised family member');
assert.equal(routeForModel('opus').model, 'claude-opus-5',
  'the launch route behind the friendly alias advances with the catalog, not only its label');
assert.equal(defaultToolModel('claude'), 'claude-fable-5-1',
  'descriptive role metadata does not hide the newly recommended flagship from fresh-session defaults');
assert.deepEqual(topProviderModels('claude').map((model) => model.id),
  ['claude-fable-5-1', 'claude-opus-5'],
  'automatic Supervisor recommendations use the same current family-filtered catalog');

console.log('model_discovery.test ok');
