// Spoken briefs for coding-agent sessions (phone + desktop voice) — gpt-5.5.
// The waiting-time summarizer optimizes for a GLANCE; this optimizes for the EAR of a developer on
// the go who must decide fast. Three detail levels, type-aware (decision/input/discussion/review/
// blocked/progress), options extracted when the agent offered choices, and aggressive
// de-terminal-ification: no URLs, no absolute paths, no context-percent footers, no spinner noise.

import { routeForModel, userRoutes } from './model_catalog.js';
import { callProxyModel } from './agents/model.js';
import { stripAnsi } from './util.js';

// ---- deterministic speech sanitizer (also used on any raw fallback text) ---------------------------
export function sanitizeForSpeech(text) {
  return String(text || '')
    .split('\n')
    // terminal junk lines: spinners, composer hints, context footers, key hints
    .filter((l) => !/^\s*[✻✽·∗●○◐◓◑◒]\s|esc to interrupt|context (left|used)|bypass permissions|\/ps to view|\/stop to close|^\s*❯|^\s*> $|tokens? used|auto-accept|shift\+tab/i.test(l))
    .join('\n')
    // URLs -> "a link" (query strings and long hosts are unspeakable)
    .replace(/https?:\/\/[^\s)>\]]+/g, 'a link')
    // absolute paths -> last meaningful segment ("the file styles.css")
    .replace(/(?:^|[\s('"`])((?:\/|~\/)[\w.@-]+(?:\/[\w.@-]+)+)/g, (m, p) => {
      const base = p.split('/').filter(Boolean).pop() || 'a file';
      return m[0].match(/[\s('"`]/) ? m[0] + base : base;
    })
    // context-window noise wherever it survives ("100% context used", "for agents")
    .replace(/\d{1,3}%\s*context\s*(used|left)/gi, '')
    .replace(/\bfor agents\b/gi, '')
    // long hex/ids are unspeakable
    .replace(/\b[a-f0-9]{12,}\b/gi, 'an id')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export const SYS_BRIEF = `You prepare SPOKEN briefs of coding-agent terminal sessions for a developer ON THE GO (driving, walking, cooking). They hear your words through text-to-speech and must grasp the situation and decide FAST. You receive the session's context (project, agent, latest report, terminal tail, supervisor notes).

Return STRICT minified JSON only, no fences:
{"topic":"<=6 words, the subject as a spoken title","kind":"decision|input|discussion|review|blocked|progress","quick":"<=20 words: what happened + what's needed, one breath","standard":"<=60 words: the situation, the one or two specifics that matter, and exactly what's being asked","detail":"<=140 words: reasoning, trade-offs, risks, what the agent already tried — for when the listener says 'more'","options":[{"key":"1","label":"short label","spoken":"how you'd say this choice in <=12 words"}],"needs":"one sentence: exactly what input unblocks the agent"}

kind: decision = the agent offered explicit choices or approval; input = it needs information/credentials/a value only the human has; discussion = it wants design feedback or is thinking out loud; review = work is finished and awaits verification/sign-off; blocked = an external failure (auth, environment, access) stops it; progress = still working, nothing needed.
options: ONLY when the agent laid out concrete choices (numbered options, yes/no approval, A-or-B). Map each to the key the terminal expects (1/2/3/y/n). Otherwise [].

EAR RULES (hard):
- Never say URLs, absolute file paths, hashes, or percent-of-context-window numbers. Say "a link", the bare file name ("styles dot css"), "an id".
- Keep EXACT names that carry the decision: command names, error names, branch names, dollar amounts, test counts.
- Round big numbers ("about three hundred files"). Spell acronyms only if ambiguous.
- Plain sentences, active voice, no markdown, no emoji, no bullet characters. Numbers as digits are fine.
- The three levels must each stand alone (don't say "as I said").
- If the supervisor flagged a hold/escalation, lead with that in standard and detail.
- Never invent: if the context doesn't say it, don't say it.`;

export function buildBriefUserText({ project, tool, category, summary, ask, screen, supervisorNote }) {
  const parts = [
    `PROJECT: ${project || 'adhoc'} · AGENT: ${tool || 'cli'} · QUEUE CATEGORY: ${category || 'review'}`,
    summary ? `WAITING-TIME SUMMARY: ${summary}` : '',
    ask ? `AGENT'S ASK (curated): ${ask}` : '',
    supervisorNote ? `SUPERVISOR: ${supervisorNote}` : '',
    screen ? `TERMINAL TAIL (raw, untrusted):\n${screen}` : '',
  ].filter(Boolean);
  return parts.join('\n\n').slice(0, 7000);
}

export function validateBrief(o) {
  if (!o || typeof o !== 'object') return null;
  const kinds = ['decision', 'input', 'discussion', 'review', 'blocked', 'progress'];
  const clamp = (s, n) => sanitizeForSpeech(String(s || '')).slice(0, n);
  const brief = {
    topic: clamp(o.topic, 60) || 'agent update',
    kind: kinds.includes(o.kind) ? o.kind : 'review',
    quick: clamp(o.quick, 160),
    standard: clamp(o.standard, 420),
    detail: clamp(o.detail, 900),
    needs: clamp(o.needs, 160),
    options: (Array.isArray(o.options) ? o.options : []).slice(0, 4).map((x) => ({
      key: String(x?.key || '').slice(0, 3),
      label: String(x?.label || '').slice(0, 40),
      spoken: clamp(x?.spoken || x?.label, 90),
    })).filter((x) => x.key && x.label),
  };
  if (!brief.standard) return null;
  if (!brief.quick) brief.quick = brief.standard.slice(0, 140);
  return brief;
}

function chain() {
  const models = ['gpt-5.5', 'claude-haiku-4-5', ...userRoutes().slice(0, 2).map((r) => r.id)];
  return [...new Set(models)];
}

const cache = new Map(); // `${sid}|${hash}` -> brief (in-memory; regenerates after restart)
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

export async function buildVoiceBrief({ sessionId, project, tool, category, summary, ask, screen, supervisorNote, call = null }) {
  const user = buildBriefUserText({ project, tool, category, summary, ask, screen: sanitizeForSpeech(stripAnsi(screen || '')).slice(-2200), supervisorNote });
  const key = `${sessionId}|${hash(user)}`;
  if (cache.has(key)) return cache.get(key);
  let brief = null;
  const invoke = call || (async (sys, u) => {
    let lastErr;
    for (const m of chain()) {
      try {
        const r = routeForModel(m);
        const out = await callProxyModel(r, [{ role: 'system', content: sys }, { role: 'user', content: u }], { temperature: 0.2, maxTokens: 700, json: true, retries: 0 });
        return out.content;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('no brief model');
  });
  try {
    const raw = await invoke(SYS_BRIEF, user);
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    brief = validateBrief(m ? JSON.parse(m[0]) : null);
  } catch {}
  if (!brief) {
    // fail-open: a sanitized template beats silence
    const gist = sanitizeForSpeech(ask || summary || '').replace(/\s+/g, ' ').slice(0, 220);
    brief = { topic: `${project || tool} update`, kind: category === 'decision' ? 'decision' : category === 'action' ? 'input' : 'review', quick: gist.slice(0, 140), standard: gist, detail: gist, needs: '', options: [] };
  }
  cache.set(key, brief);
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return brief;
}

export function speakBrief(brief, { level = 'standard', withTopic = true, prefix = '' } = {}) {
  const body = brief[level] || brief.standard;
  const opts = brief.options?.length && level !== 'quick'
    ? ' Options: ' + brief.options.map((o) => `${o.key}, ${o.spoken || o.label}`).join('. ') + '.'
    : '';
  return [prefix, withTopic ? brief.topic + '.' : '', body, opts].filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();
}
