const MTOK = 1_000_000;

export const PRICE_SOURCES = [
  {
    id: 'openai',
    label: 'OpenAI API pricing',
    url: 'https://openai.com/api/pricing/',
    note: 'Standard API rates. OpenAI states API billing is separate from ChatGPT subscriptions.',
  },
  {
    id: 'anthropic',
    label: 'Claude API pricing',
    url: 'https://platform.claude.com/docs/en/about-claude/pricing',
    note: 'Standard first-party Claude API rates. Claude cache creation is treated as 5-minute cache writes.',
  },
  {
    id: 'google',
    label: 'Gemini Developer API pricing',
    url: 'https://ai.google.dev/gemini-api/docs/pricing',
    note: 'Paid-tier Gemini Developer API standard rates for text/image/video token usage.',
  },
  {
    id: 'alibaba-intl',
    label: 'Alibaba Model Studio international pricing',
    url: 'https://www.alibabacloud.com/help/en/model-studio/models',
    note: 'International Model Studio token rates used for Qwen API-equivalent estimates.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek API pricing',
    url: 'https://api-docs.deepseek.com/quick_start/pricing',
    note: 'DeepSeek official USD token rates for Aliyun-routed DeepSeek models.',
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi API pricing',
    url: 'https://platform.moonshot.ai/docs/pricing',
    note: 'Moonshot official USD token rates for Aliyun-routed Kimi models.',
  },
  {
    id: 'zhipu',
    label: 'Zhipu GLM API pricing',
    url: 'https://docs.z.ai/guides/model/overview',
    note: 'Zhipu official USD token rates for Aliyun-routed GLM models.',
  },
];

const RULES = [
  rule('openai:gpt-5.5', 'openai', /^gpt-5\.5(?:$|-)/, {
    input: 5,
    cachedInput: 0.5,
    output: 30,
    label: 'GPT-5.5',
  }),
  rule('openai:gpt-5.4-mini', 'openai', /^gpt-5\.4-mini(?:$|-)/, {
    input: 0.75,
    cachedInput: 0.075,
    output: 4.5,
    label: 'GPT-5.4 mini',
  }),
  rule('openai:gpt-5.4', 'openai', /^gpt-5\.4(?:$|-)/, {
    input: 2.5,
    cachedInput: 0.25,
    output: 15,
    label: 'GPT-5.4',
  }),

  rule('anthropic:fable-5', 'anthropic', /^claude-(?:fable|mythos)-5(?:$|-)/, {
    input: 10,
    cacheWrite: 12.5,
    cacheRead: 1,
    output: 50,
    label: 'Claude Fable 5',
  }),
  rule('anthropic:opus-4.x', 'anthropic', /^claude-opus-4-(?:8|7|6|5)(?:$|-)/, {
    input: 5,
    cacheWrite: 6.25,
    cacheRead: 0.5,
    output: 25,
    label: 'Claude Opus 4.x',
  }),
  rule('anthropic:sonnet-4.x', 'anthropic', /^claude-sonnet-4(?:-(?:6|5))?(?:$|-)/, {
    input: 3,
    cacheWrite: 3.75,
    cacheRead: 0.3,
    output: 15,
    label: 'Claude Sonnet 4.x',
  }),
  rule('anthropic:haiku-4.5', 'anthropic', /^claude-haiku-4-5(?:$|-)/, {
    input: 1,
    cacheWrite: 1.25,
    cacheRead: 0.1,
    output: 5,
    label: 'Claude Haiku 4.5',
  }),

  rule('google:gemini-3.5-flash', 'google', /^gemini-3\.5-flash(?:$|-)/, {
    input: 1.5,
    cachedInput: 0.15,
    output: 9,
    label: 'Gemini 3.5 Flash',
  }),
  rule('google:gemini-3.1-flash-lite', 'google', /^gemini-3\.1-flash-lite(?:$|-)/, {
    input: 0.25,
    cachedInput: 0.025,
    output: 1.5,
    label: 'Gemini 3.1 Flash-Lite',
  }),
  rule('google:gemini-3-flash', 'google', /^gemini-3-flash(?:$|-)/, {
    input: 0.5,
    cachedInput: 0.05,
    output: 3,
    label: 'Gemini 3 Flash',
  }),

  rule('alibaba:qwen3.7-max', 'alibaba-intl', /^qwen3\.7-max$/i, {
    input: 1.2,
    output: 6,
    label: 'Qwen3.7-Max',
  }),
  rule('alibaba:qwen3.6-plus', 'alibaba-intl', /^qwen3\.6-plus$/i, {
    input: 0.4,
    output: 2.4,
    label: 'Qwen3.6 Plus',
  }),
  rule('alibaba:qwen3.6-flash', 'alibaba-intl', /^qwen3\.6-flash$/i, {
    input: 0.1,
    output: 0.4,
    label: 'Qwen3.6 Flash',
  }),
  rule('alibaba:qwen-max-family', 'alibaba-intl', /^qwen.*max/i, {
    input: 1.2,
    output: 6,
    label: 'Qwen Max family',
  }),
  rule('alibaba:qwen-plus-family', 'alibaba-intl', /^qwen.*plus/i, {
    input: 0.4,
    output: 2.4,
    label: 'Qwen Plus family',
  }),
  rule('alibaba:qwen-flash-family', 'alibaba-intl', /^qwen.*(?:flash|turbo)/i, {
    input: 0.1,
    output: 0.4,
    label: 'Qwen Flash family',
  }),
  rule('deepseek:v4-pro', 'deepseek', /^deepseek-v4-pro$/i, {
    input: 0.435,
    cachedInput: 0.003625,
    output: 0.87,
    label: 'DeepSeek V4 Pro',
  }),
  rule('deepseek:v4-flash', 'deepseek', /^deepseek-v4-flash$|^deepseek-v3\.2$/i, {
    input: 0.14,
    cachedInput: 0.0028,
    output: 0.28,
    label: 'DeepSeek V4 Flash',
  }),
  rule('moonshot:kimi-k2.6', 'moonshot', /^kimi-k2\.(?:6|5)$/i, {
    input: 0.95,
    cachedInput: 0.16,
    output: 4,
    label: 'Kimi K2.6',
  }),
  rule('zhipu:glm-5', 'zhipu', /^glm-5(?:\.1)?$/i, {
    input: 1,
    cachedInput: 0.2,
    output: 3.2,
    label: 'GLM-5',
  }),
  rule('minimax:m2.5', 'minimax', /^minimax-m2\.5$/i, {
    input: 0.3,
    output: 1.2,
    label: 'MiniMax M2.5 estimate',
  }),
];

function rule(id, provider, match, prices) {
  return { id, provider, match, source: provider, ...prices };
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : 0;
}

export function pricingCatalog() {
  return {
    generatedAt: Date.now(),
    unit: 'USD per 1M tokens',
    estimateKind: 'api-equivalent',
    disclaimer: 'Subscription CLIs may burn quota rather than bill these exact API dollars. Prices are used for relative cost visibility.',
    sources: PRICE_SOURCES,
    rules: RULES.map(({ match, ...r }) => ({ ...r, match: String(match) })),
  };
}

export function priceRuleFor({ model, provider, tool } = {}) {
  const m = String(model || '').toLowerCase();
  if (!m || m === '(unknown)' || m === '<synthetic>') return null;
  const p = String(provider || tool || '').toLowerCase();
  return RULES.find((r) => r.match.test(m) && (!p || p === r.provider || providerAlias(p, r.provider))) || RULES.find((r) => r.match.test(m)) || null;
}

function providerAlias(actual, expected) {
  if (expected === 'google') return actual === 'agy' || actual === 'antigravity' || actual === 'gemini';
  if (expected === 'openai') return actual === 'codex';
  if (expected === 'alibaba-intl') return actual === 'aliyun' || actual === 'alibaba' || actual === 'spark';
  return false;
}

export function priceUsage(row = {}) {
  const r = priceRuleFor(row);
  if (!r) {
    return {
      estimated_cost_usd: 0,
      pricing_known: false,
      priced_events: 0,
      unpriced_events: n(row.events) || 1,
      price_rule: null,
      price_source: null,
      unpriced_tokens: n(row.total_tokens) + n(row.cached_input_tokens),
    };
  }

  const input = n(row.input_tokens);
  const cached = n(row.cached_input_tokens);
  const cacheCreation = n(row.cache_creation_input_tokens);
  const cacheRead = n(row.cache_read_input_tokens);
  const output = n(row.output_tokens);
  let cost = 0;

  if (r.provider === 'anthropic') {
    cost += input * r.input;
    cost += cacheCreation * r.cacheWrite;
    cost += cacheRead * r.cacheRead;
    cost += output * r.output;
  } else {
    const cachedInput = cached || cacheRead;
    cost += Math.max(0, input - cachedInput) * r.input;
    cost += cachedInput * (r.cachedInput ?? r.input);
    cost += output * r.output;
  }

  return {
    estimated_cost_usd: cost / MTOK,
    pricing_known: true,
    priced_events: n(row.events) || 1,
    unpriced_events: 0,
    price_rule: r.id,
    price_source: r.source,
    unpriced_tokens: 0,
  };
}

export function mergeCost(a = {}, b = {}) {
  return {
    estimated_cost_usd: n(a.estimated_cost_usd) + n(b.estimated_cost_usd),
    priced_events: n(a.priced_events) + n(b.priced_events),
    unpriced_events: n(a.unpriced_events) + n(b.unpriced_events),
    unpriced_tokens: n(a.unpriced_tokens) + n(b.unpriced_tokens),
  };
}
