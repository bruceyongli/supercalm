import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyCatalog, currentProviders, topProviderModels } from '../src/model_catalog.js';
import {
  automaticSupervisorChain,
  SUPERVISOR_MODELS_PER_PROVIDER,
  supervisorProviderOrder,
} from '../src/agents/supervisor/model_defaults.js';

const provider = (proxy, recommended, models, up = true) => ({
  proxy,
  label: proxy === 'codex' ? 'OpenAI' : proxy === 'claude' ? 'Claude' : 'Aliyun',
  port: proxy === 'codex' ? 8788 : proxy === 'claude' ? 8789 : 8790,
  up,
  recommended,
  models: models.map((id) => ({ id, label: id, kind: 'chat', recommended: recommended.includes(id) })),
});

applyCatalog([
  provider('codex', ['openai-next', 'openai-balanced', 'openai-fast', 'openai-old'],
    ['openai-old', 'openai-fast', 'openai-next', 'openai-balanced']),
  provider('claude', ['claude-next', 'claude-balanced', 'claude-fast', 'claude-old'],
    ['claude-old', 'claude-fast', 'claude-next', 'claude-balanced']),
  provider('aliyun', ['aliyun-next', 'aliyun-balanced', 'aliyun-fast', 'aliyun-old'],
    ['aliyun-old', 'aliyun-fast', 'aliyun-next', 'aliyun-balanced']),
], { source: 'test' });

assert.equal(SUPERVISOR_MODELS_PER_PROVIDER, 3);
assert.deepEqual(currentProviders().find((row) => row.proxy === 'codex').recommended,
  ['openai-next', 'openai-balanced', 'openai-fast', 'openai-old'],
  'catalog normalization preserves the provider recommendation order');
assert.deepEqual(topProviderModels('codex').map((model) => model.id),
  ['openai-next', 'openai-balanced', 'openai-fast'],
  'provider recommendation order outranks raw model-list order');
assert.deepEqual(automaticSupervisorChain('agy'), [
  'openai-next', 'openai-balanced', 'openai-fast',
  'claude-next', 'claude-balanced', 'claude-fast',
  'aliyun-next', 'aliyun-balanced', 'aliyun-fast',
], 'default tools receive the latest top three from all requested providers');
assert.deepEqual(supervisorProviderOrder('codex'), ['claude', 'aliyun', 'codex']);
assert.deepEqual(automaticSupervisorChain('codex'), [
  'claude-next', 'claude-balanced', 'claude-fast',
  'aliyun-next', 'aliyun-balanced', 'aliyun-fast',
  'openai-next', 'openai-balanced', 'openai-fast',
], 'the watched session provider is last without dropping any of its top three');

// A catalog refresh alone changes the default; no Supervisor source/version edit is involved.
applyCatalog([
  provider('codex', ['openai-future', 'openai-next', 'openai-balanced'],
    ['openai-future', 'openai-next', 'openai-balanced', 'openai-fast']),
  provider('claude', ['claude-next', 'claude-balanced', 'claude-fast'],
    ['claude-next', 'claude-balanced', 'claude-fast']),
  provider('aliyun', ['aliyun-next', 'aliyun-balanced', 'aliyun-fast'],
    ['aliyun-next', 'aliyun-balanced', 'aliyun-fast']),
], { source: 'refresh-test' });
assert.equal(automaticSupervisorChain('agy')[0], 'openai-future',
  'a newly recommended provider model becomes the primary on the next catalog refresh');

// Down providers are not put into a runnable default chain when other providers remain available.
applyCatalog([
  provider('codex', ['openai-next', 'openai-balanced', 'openai-fast'],
    ['openai-next', 'openai-balanced', 'openai-fast']),
  provider('claude', ['claude-next', 'claude-balanced', 'claude-fast'],
    ['claude-next', 'claude-balanced', 'claude-fast'], false),
  provider('aliyun', ['aliyun-next', 'aliyun-balanced', 'aliyun-fast'],
    ['aliyun-next', 'aliyun-balanced', 'aliyun-fast']),
], { source: 'availability-test' });
assert.ok(!automaticSupervisorChain('agy').some((id) => id.startsWith('claude-')),
  'a provider known to be down is skipped until a later scan marks it live');

const supervisorSource = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
assert.doesNotMatch(supervisorSource, /automaticSupervisorChain\(tool\)/,
  'the operating chain is closed at the qualified pair instead of silently admitting catalog arrivals');
assert.match(supervisorSource, /codex:\s*Object\.freeze\(\['claude-opus-4-8', 'gpt-5\.6-sol'\]\)/,
  'Codex sessions lead with the available exact Claude Opus model');
assert.match(supervisorSource, /claude:\s*Object\.freeze\(\['gpt-5\.6-sol', 'claude-opus-4-8'\]\)/,
  'Claude sessions lead with GPT-5.6 Sol');
assert.doesNotMatch(supervisorSource, /gemini-pro-agent'\]/,
  'the former hard-coded three-model fleet chain is gone');

console.log('supervisor_model_defaults.test ok');
