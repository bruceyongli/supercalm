import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fleetKey, listProxyModels, routeForModel } from '../model_catalog.js';

// Shared proxy-model transport for panel agents. Consolidates the hand-rolled /v1/chat/completions
// callers (the old supervisor.js chat() + llm.js once()). Pure transport + parse: NO usage recording
// or capability checks here — those live in context.js so this stays reusable and store-free.

const CHAT_TIMEOUT_MS = Number(process.env.AIOS_AGENT_MODEL_TIMEOUT_MS || 90000);

// A route is a vision route if its provider/model can accept image_url content parts.
export function isVisionRoute(route) {
  const proxy = route?.proxy;
  const id = String(route?.model || route?.id || '').toLowerCase();
  if (['antigravity', 'gemini', 'codex', 'claude'].includes(proxy)) return true;
  if (proxy === 'aliyun') return /max|plus|-vl|vision/.test(id);
  return false;
}

// Transient proxy/upstream failures: the proxy surfaces its own upstream error in the error envelope
// (e.g. "fetch failed" when the real model API briefly can't be reached), plus connection blips and
// 429/5xx. Retry these a couple of times so one hiccup doesn't fail a review/summary and stop the
// supervisor from sending.
const TRANSIENT_RX = /fetch failed|timeout|timed out|ECONNREFUSED|ECONNRESET|socket hang up|EAI_AGAIN|network|temporarily|unavailable|overloaded|rate.?limit|\b(429|500|502|503|504)\b/i;
function isTransient(e) {
  return TRANSIENT_RX.test(String(e?.message || e || ''));
}

// POST chat-completions to a resolved fleet route, retrying transient failures. `messages` may contain
// OpenAI-style multimodal content arrays (text + image_url). Returns { content, usage, raw, model }.
export async function callProxyModel(route, messages, opts = {}) {
  const tries = Math.max(0, opts.retries ?? 2);
  let lastErr;
  for (let i = 0; i <= tries; i++) {
    try {
      return await callOnce(route, messages, opts);
    } catch (e) {
      lastErr = e;
      if (i < tries && isTransient(e)) {
        await delay(500 * (i + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function callOnce(route, messages, { temperature = 0.1, maxTokens = 4000, json = false } = {}) {
  return new Promise((resolve, reject) => {
    fleetKey().then((key) => {
      const body = { model: route.model, temperature, messages };
      if (route.proxy === 'codex') body.reasoning_effort = 'low';
      else body.max_tokens = maxTokens;
      // claude proxy doesn't take response_format; rely on the prompt + parseJsonObject salvage instead.
      if (json && route.proxy !== 'claude') body.response_format = { type: 'json_object' };
      if (route.proxy === 'aliyun') body.enable_search = false;
      const data = Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          host: '127.0.0.1',
          port: route.port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': data.length, authorization: `Bearer ${key}` },
          timeout: CHAT_TIMEOUT_MS,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let env;
            try {
              env = JSON.parse(raw);
            } catch {
              return reject(new Error('model returned a non-JSON envelope'));
            }
            if (env.error) return reject(new Error(env.error.message || JSON.stringify(env.error)));
            const c = env.choices?.[0]?.message?.content ?? env.choices?.[0]?.text ?? '';
            const content = Array.isArray(c) ? c.map((p) => p.text || '').join('\n') : String(c || '');
            resolve({ content, usage: env.usage || null, raw, model: env.model || route.model });
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('agent model timeout')));
      req.write(data);
      req.end();
    }, reject);
  });
}

// Curated, de-duped list of recommended chat models from the live proxy catalog, with vision flags.
// Shared by agents that expose a model picker (supervisor, builder).
export function curatedModels(defaultModel) {
  const seen = new Set();
  const out = [];
  for (const m of listProxyModels()) {
    if ((m.kind || 'chat') === 'image' || !m.recommended || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ id: m.id, label: m.label, provider: m.provider, vision: isVisionRoute(routeForModel(m.id)) });
  }
  if (defaultModel && !seen.has(defaultModel)) {
    const r = routeForModel(defaultModel);
    out.unshift({ id: defaultModel, label: r.providerLabel ? `${r.providerLabel} / ${r.label}` : defaultModel, provider: r.proxy, vision: isVisionRoute(r) });
  }
  return out;
}

// Extract the first balanced {...} object from model output (tolerates code fences + reasoning prose).
export function parseJsonObject(s) {
  const text = String(s || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(text);
  } catch {}
  const i = text.indexOf('{');
  if (i < 0) throw new Error('model did not return a JSON object');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(text.slice(i, j + 1));
  }
  throw new Error('model returned an unterminated JSON object');
}
