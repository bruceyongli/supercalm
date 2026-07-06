import http from 'node:http';
import { fleetKey } from './model_catalog.js';

// Local-proxy chat with a fallback chain. Default brain for the voice concierge,
// chosen by a faithfulness+latency benchmark (NOT speed alone — see README/commit):
// each model scored on the right action (await/send/next/stop), confirm-before-send,
// strict JSON, and latency, on the real voice prompt. Provider-diverse so one upstream
// outage can't kill voice:
//   gemini-3.1-flash-lite (8791) — fastest faithful: 7/7, strict JSON, ~1.4s
//   kimi-k2.6             (8790) — 7/7 faithful, smart, separate aliyun quota
//   claude-haiku-4-5      (8789) — Anthropic-reliable fallback, ~2.0s
// gemini-3.1-flash-lite leads — both more faithful AND faster than claude-haiku (6/7;
// it eager-sends a bare instruction). NOTE: the 8791 proxy is fine to use (no ban-risk).
// Not chosen: deepseek-v4 + the big claude/gpt models eager-send (skip the confirm step);
// glm-5.1 emits no parseable JSON; the 8787 gemini-cli pool was rate-limited (429) at
// bench time. Override the chain with AIOS_VOICE_CHAIN ("port:model,port:model,...").
export const VOICE_CHAIN = (process.env.AIOS_VOICE_CHAIN ||
  '8791:gemini-3.1-flash-lite,8790:kimi-k2.6,8789:claude-haiku-4-5')
  .split(',')
  .map((s) => {
    const [port, ...rest] = s.split(':');
    return { port: Number(port), model: rest.join(':') };
  });

async function once(port, model, messages, { temperature = 0.3, max_tokens = 700 } = {}) {
  const key = await fleetKey(); // the proxy fleet rejects keyless calls
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ model, messages, temperature, max_tokens }));
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length, authorization: `Bearer ${key}` }, timeout: 45000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const env = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const content = env.choices?.[0]?.message?.content;
            if (!content) return reject(new Error(env.error?.message || 'no content'));
            resolve(content);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('llm timeout')));
    req.write(data);
    req.end();
  });
}

// Try each model in the chain until one returns content. Returns { content, model }.
export async function chat(messages, opts = {}, chain = VOICE_CHAIN) {
  let lastErr;
  for (const { port, model } of chain) {
    try {
      const content = await once(port, model, messages, opts);
      return { content, model };
    } catch (e) {
      lastErr = e;
      console.error(`[aios] llm ${model}@${port} failed: ${e.message}`);
    }
  }
  throw lastErr || new Error('no models available');
}

// Extract the first balanced {...} object (ignores reasoning/prose around it; the old
// greedy /\{[\s\S]*\}/ over-grabbed when models emit thinking text containing braces).
function firstJsonObject(s) {
  const i = s.indexOf('{');
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(i, j + 1);
  }
  return null; // unbalanced (truncated)
}

// Parse a JSON object from model output. Tolerates code fences, reasoning prefixes,
// AND truncated/malformed JSON (salvages say/action/message via regex).
export function parseJson(content) {
  const c = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const obj = firstJsonObject(c);
  if (obj) {
    try {
      return JSON.parse(obj);
    } catch {}
  }
  const grab = (k) => {
    const mm = c.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (!mm) return undefined;
    try { return JSON.parse('"' + mm[1] + '"'); } catch { return mm[1]; }
  };
  const say = grab('say');
  const action = (c.match(/"action"\s*:\s*"(\w+)"/) || [])[1];
  const message = grab('message');
  if (say != null || action) return { say, action, message };
  throw new Error('unparseable model JSON');
}

// Like chat(), but requires valid JSON — falls through the chain if a model returns
// junk, so an unreliable primary can't break the flow. Returns { obj, model }.
export async function chatJson(messages, opts = {}, chain = VOICE_CHAIN) {
  let lastErr;
  for (const { port, model } of chain) {
    try {
      const content = await once(port, model, messages, opts);
      return { obj: parseJson(content), model };
    } catch (e) {
      lastErr = e;
      console.error(`[aios] llm ${model}@${port}: ${e.message}`);
    }
  }
  throw lastErr || new Error('no models available');
}
