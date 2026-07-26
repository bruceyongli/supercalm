import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { groupedModelOptions, modelOptionLabel } from '../web/model-select.js';

const models = [
  {
    id: 'gpt-5.6-sol',
    label: 'Codex / GPT-5.6 Sol',
    modelLabel: 'GPT-5.6 Sol',
    provider: 'codex',
    providerLabel: 'Codex',
    vision: true,
  },
  {
    id: 'claude-opus',
    label: 'Claude / Claude Opus 4.8',
    modelLabel: 'Claude Opus 4.8',
    provider: 'claude',
    providerLabel: 'Claude',
    vision: true,
  },
  {
    id: 'qwen',
    label: 'Spark / Qwen 3',
    modelLabel: 'Qwen 3',
    provider: 'spark',
    providerLabel: 'Spark',
  },
];

assert.equal(modelOptionLabel(models[0]), 'GPT-5.6 Sol (vision)');
assert.equal(modelOptionLabel(models[1]), 'Opus 4.8 (vision)');

const html = groupedModelOptions(models, {
  selected: 'claude-opus',
  leading: [{ value: '', label: 'Auto' }],
});
assert.match(html, /<optgroup label="Codex">/);
assert.match(html, /<optgroup label="Claude">/);
assert.match(html, /<optgroup label="Spark">/);
assert.match(html, />GPT-5\.6 Sol \(vision\)<\/option>/);
assert.match(html, /value="claude-opus" selected/);
assert.doesNotMatch(html, />Codex \//, 'provider is not repeated in option text');
assert.doesNotMatch(html, />Claude (?:\/|Claude )/, 'Claude is not repeated in option text');

const custom = groupedModelOptions(models, { selected: '<custom>' });
assert.match(custom, /value="&lt;custom&gt;" selected/, 'custom selections are preserved and escaped');

const pickerFiles = [
  'web/shell.js',
  'web/app.js',
  'web/session.js',
  'web/agents/builder.js',
  'web/agents/knowledge.js',
  'web/agents/map.js',
  'web/agents/preflight.js',
  'web/agents/supervisor.js',
];
for (const file of pickerFiles) {
  const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  assert.match(source, /groupedModelOptions/, `${file} uses the shared categorized model renderer`);
}

console.log('model_select.test ok');
