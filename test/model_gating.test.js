// Model availability gating — locks the first-time-user fix (2026-07-16): "It showed all models,
// and most models are not available to the user." Pickers that offer models to RUN must exclude
// providers whose last scan found the port unreachable (`up:false` — a fleet-less install marks
// every fleet provider down on its first scan). The exception that keeps fresh installs usable:
// a tool's OWN provider ids ride the CLI's native login (claude --model / codex -c model=), so
// they stay offered regardless of fleet reachability. model_catalog.js is pure (no store/server
// import), so the logic is tested directly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyCatalog, listProxyModels, toolModels, modelDisplayLabel } from '../src/model_catalog.js';

// A fleet where only claude's port answered the scan — codex/aliyun are down (fresh-install shape:
// after the first scan EVERY provider would be down; claude-up keeps the cross-provider case testable).
applyCatalog([
  { proxy: 'claude', label: 'Claude', port: 8789, nativeFor: ['claude'], up: true,
    models: [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8', recommended: true }, { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }, { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }] },
  { proxy: 'codex', label: 'Codex', port: 8788, nativeFor: ['codex'], up: false,
    models: [{ id: 'gpt-5.5', label: 'GPT-5.5', recommended: true }] },
  { proxy: 'aliyun', label: 'Aliyun', port: 8790, nativeFor: [], up: false,
    models: [{ id: 'kimi-k2.6', label: 'Kimi K2.6', recommended: true }, { id: 'qwen-image-2.0', label: 'Qwen Image 2.0', kind: 'image' }] },
], { source: 'test' });

// ---- liveOnly drops down providers; the default keeps the full catalog ----
{
  const live = listProxyModels({ liveOnly: true }).map((m) => m.id);
  assert.ok(live.includes('claude-opus-4-8'), 'up provider listed');
  assert.ok(!live.includes('kimi-k2.6'), 'down provider dropped from live listings');
  assert.ok(!live.includes('gpt-5.5'), 'down provider dropped even when nativeFor someone (liveOnly is availability, not tool policy)');
  const full = listProxyModels().map((m) => m.id);
  assert.ok(full.includes('kimi-k2.6') && full.includes('gpt-5.5'), 'default listing keeps the full catalog for admin/label surfaces');
}

// ---- toolModels: own-CLI models survive a down fleet; cross-provider models are live-gated ----
{
  const codex = toolModels('codex').map((m) => m.id);
  assert.ok(codex.includes('gpt-5.5'), "codex still offers gpt-5.5 with its provider down — the CLI's own login serves it");
  assert.ok(!codex.includes('kimi-k2.6'), 'codex does NOT offer a down cross-provider model (needs the bridge → a reachable port)');

  const claude = toolModels('claude').map((m) => m.id);
  assert.ok(claude.includes('opus') || claude.includes('claude-opus-4-8'), 'claude offers its native models/aliases');
  assert.ok(!claude.includes('kimi-k2.6'), 'claude does NOT offer a down cross-provider model');
}

// ---- stored sessions keep their labels even when the provider is down ----
assert.ok(String(modelDisplayLabel('kimi-k2.6')).includes('Kimi'), 'display label still resolves for a down provider (history/session rows)');

// ---- source locks: every run-picker call site passes liveOnly ----
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const sess = read('src/sessions.js');
assert.equal((sess.match(/listProxyModels\(\{ includeImages: false, liveOnly: true \}\)/g) || []).length, 2,
  'both sessions.js pickers (space labeling + helpers panel) are live-gated');
assert.ok(/listProxyModels\(\{ liveOnly: true \}\)/.test(read('src/agents/model.js')), 'curatedModels (supervisor/builder pickers) is live-gated');
assert.equal((read('src/model_proxy.js').match(/listProxyModels\(\{ liveOnly: true \}\)/g) || []).length, 2,
  'the cli-proxy bridge offers only routable (up) models');

console.log('model_gating: all assertions passed');
