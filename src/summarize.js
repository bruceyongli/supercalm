import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { stripAnsi } from './util.js';
import { fleetKey, userRoutes, routeForModel } from './model_catalog.js';
import { callProxyModel } from './agents/model.js';

// Summarize a waiting session's screen into {category, summary} using a local proxy model.
// Default: claude-haiku-4-5 (fast + accurate on technical text). Override via env.
const PORT = Number(process.env.AIOS_SUMMARY_PORT || 8789);
const MODEL = process.env.AIOS_SUMMARY_MODEL || 'claude-haiku-4-5';

const SYS = `You triage a terminal running an autonomous coding agent (claude/codex/agy) for a human operator who only wants to be interrupted when truly needed.
Read the latest screen and return STRICT minified JSON ONLY — no markdown, no code fences:
{"category":"action|decision|review|working","summary":"<one sentence>","ask":"<core context, see below>","stage":"planning|awaiting_approval|executing|blocked|review"}
category:
- "decision": the agent is asking the operator to choose/approve/answer something before it can continue.
- "action": the agent is blocked and needs the operator to DO something (provide info, fix the environment, log in, resolve an error).
- "review": the agent finished its task or turn and is idle, waiting for review or the next instruction.
- "working": the agent is still actively running and is NOT waiting on the operator.
stage: WHERE the session is in its lifecycle (independent of category). This decides whether a supervisor should stand down:
- "planning": still deciding WHAT to build — the agent is proposing/outlining a plan or design, or the operator is iterating a design doc / giving more feedback rounds. Little or no code written yet. Coding has NOT started.
- "awaiting_approval": the agent has presented a plan/design/options and is explicitly waiting for the operator to approve, choose, or "say go" before it starts building.
- "executing": actively implementing an agreed plan — writing/editing/running code toward the goal.
- "blocked": stopped on an external blocker (auth/login, missing access, an environment error) that needs the operator.
- "review": the agent claims the work is done/complete and is waiting for verification or sign-off.
Pick "planning" or "awaiting_approval" whenever the plan itself is still being shaped or approved — even if the agent is technically asking a question. Only pick "executing"/"review" once building has actually begun.
summary: ONE precise sentence, <=140 chars. Preserve technical terms, filenames, commands and errors EXACTLY. State what the operator must decide/do, or what was completed. No preamble.
ask: the CORE of why the operator is being pinged — the agent's REASONING and the relevant BACKGROUND that motivate this decision/action, plus the specific question or choice (and any options/trade-offs the agent laid out). 1-4 clean sentences of plain prose, faithful to the agent's own words. EXCLUDE terminal trash: command output, file diffs/edits, stack traces, tool logs, progress bars, spinners, the composer UI. If category is "working", set ask to "".
CRITICAL: Ignore the composer placeholder hint — the greyed suggestion shown next to '>' or '❯' (e.g. "Explain this codebase", "Write tests for @filename", "Summarize recent commits"). It is a rotating UI hint, NOT a real task, instruction, or question.`;

async function chat(payload) {
  const key = await fleetKey(); // the proxy fleet rejects keyless calls
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload));
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length, authorization: `Bearer ${key}` }, timeout: 30000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('summary timeout')));
    req.write(data);
    req.end();
  });
}

function cleanScreen(snap) {
  return stripAnsi(snap || '')
    .split('\n')
    .map((l) => l.replace(/[│╭╮╰╯─━┃▌▐]/g, ' ').replace(/\s+$/, ''))
    .filter((l) => l.trim())
    .slice(-45)
    .join('\n')
    .slice(-4000);
}

const CATS = ['action', 'decision', 'review', 'working'];
const STAGES = ['planning', 'awaiting_approval', 'executing', 'blocked', 'review'];

export async function summarize(snap) {
  const screen = cleanScreen(snap);
  if (!screen) return null;
  const payload = {
    model: MODEL,
    temperature: 0,
    max_tokens: 600,
    messages: [
      { role: 'system', content: SYS },
      { role: 'user', content: 'SCREEN:\n' + screen },
    ],
  };
  // Retry transient proxy/upstream blips (the proxy surfaces "fetch failed" / 5xx when the real model
  // API briefly can't be reached) so one hiccup doesn't drop a queue summary.
  let env;
  let content = null;
  for (let i = 0; ; i++) {
    try {
      env = JSON.parse(await chat(payload));
      if (env.error) throw new Error(env.error.message || JSON.stringify(env.error));
      break;
    } catch (e) {
      if (i < 2 && /fetch failed|timeout|timed out|ECONNREFUSED|ECONNRESET|socket hang up|EAI_AGAIN|network|unavailable|overloaded|rate.?limit|\b(429|500|502|503|504)\b/i.test(String(e?.message || e))) {
        await sleep(500 * (i + 1));
        continue;
      }
      // Fleet unreachable/exhausted: user API providers (Auth & Models) carry the summary — the
      // needs-you queue must work for installs whose only model source is an API key.
      const fallback = userRoutes()[0];
      if (!fallback) throw e;
      const out = await callProxyModel(routeForModel(fallback.id), payload.messages, { temperature: payload.temperature ?? 0, maxTokens: 500 });
      content = out.content.trim();
      break;
    }
  }
  if (content === null) content = (env.choices?.[0]?.message?.content || '').trim();
  content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const m = content.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(m ? m[0] : content);
  const category = CATS.includes(parsed.category) ? parsed.category : 'review';
  const summary = String(parsed.summary || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const ask = String(parsed.ask || '').replace(/\s+/g, ' ').trim().slice(0, 2000); // model-distilled core (reasoning + background + question)
  const stage = STAGES.includes(parsed.stage) ? parsed.stage : ''; // '' = unknown -> supervisor falls back to its heuristic
  return { category, summary, ask, stage, needsYou: category !== 'working', model: MODEL };
}
