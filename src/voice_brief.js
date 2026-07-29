// Spoken briefs for coding-agent sessions (phone + desktop voice).
// Automatic reports are grounded in the operator's original request and the latest curated attention
// report. Raw terminal tails are intentionally excluded: source code, TUI chrome, and transient
// symbols are useful for inspection but make terrible spoken conversation.

import { routeForModel, userRoutes } from './model_catalog.js';
import { callProxyModel } from './agents/model.js';

// ---- deterministic speech sanitizer (also used on any fallback text) -------------------------------
export function sanitizeForSpeech(text) {
  return String(text || '')
    // Omit source blocks rather than making a voice spell their punctuation.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
    .replace(/<[^>]{1,200}>/g, ' ')
    .split('\n')
    // terminal junk lines: spinners, composer hints, context footers, key hints
    .filter((l) => !/^\s*[✻✽·∗●○◐◓◑◒]\s|esc to interrupt|context (left|used)|bypass permissions|\/ps to view|\/stop to close|^\s*❯|^\s*> $|tokens? used|auto-accept|shift\+tab/i.test(l))
    .map((line) => line.replace(/^\s*(?:[-+*•‣▪◦]|\d+[.)])\s+/, ''))
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
    // Session ids, UUID-like tokens, and source-control hashes are not meaningful to the ear.
    .replace(/\bs_[a-z0-9]{6,}\b/gi, 'a session')
    .replace(/\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/gi, 'an id')
    .replace(/\b[a-f0-9]{12,}\b/gi, 'an id')
    // Translate common code-ish tokens into words, then remove drawing/markdown punctuation.
    .replace(/\b([A-Za-z][\w-]{1,40})\.(?:js|mjs|cjs|ts|tsx|jsx|css|html|json|md|py|sh)\b/gi, '$1 file')
    .replace(/([A-Za-z])[_-]+(?=[A-Za-z])/g, '$1 ')
    .replace(/[│┃┆┊┌┐└┘├┤┬┴┼╭╮╰╯─━]+/g, ' ')
    .replace(/[#*`_{}[\]<>\\|~^]+/g, ' ')
    .replace(/(?:-{3,}|={3,})/g, ' ')
    .replace(/(^|\s)(?:=>|->|::|&&|\|\||[+>=]{1,2})(?=\s|$)/g, '$1 ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export const SYS_BRIEF = `You prepare SPOKEN briefs of coding-agent sessions for a developer ON THE GO (driving, walking, cooking). They hear your words through text-to-speech and must grasp the situation and decide FAST. You receive the project, agent, operator's original request, latest curated report, and supervisor notes.

Return STRICT minified JSON only, no fences:
{"topic":"<=6 words, the subject as a spoken title","kind":"decision|input|discussion|review|blocked|progress","request":"<=45 words: natural spoken restatement of the operator's original request","updates":[{"requested":"<=12 words: one distinct thing the operator requested","latest":"<=35 words: latest reported outcome or need for that thing"}],"quick":"<=20 words: what happened + what's needed, one breath","standard":"<=60 words: natural summary of the latest report","detail":"<=140 words: reasoning, trade-offs, risks, what the agent already tried — for when the listener says 'more'","options":[{"key":"1","label":"short label","spoken":"how you'd say this choice in <=12 words"}],"needs":"one sentence: exactly what input unblocks the agent"}

SOURCE PRIORITY:
- ORIGINAL REQUEST says what the operator actually asked for.
- LATEST REPORT says what happened. Build one updates entry for EACH distinct requested deliverable that the latest report addresses, up to 6.
- If the latest report does not say what happened to one requested deliverable, say "No separate outcome was reported" instead of guessing.
- Do not repeat the whole report or invent a status.

kind: decision = the agent offered explicit choices or approval; input = it needs information/credentials/a value only the human has; discussion = it wants design feedback or is thinking out loud; review = work is finished and awaits verification/sign-off; blocked = an external failure (auth, environment, access) stops it; progress = still working, nothing needed.
options: ONLY when the agent laid out concrete choices (numbered options, yes/no approval, A-or-B). Map each to the key the terminal expects (1/2/3/y/n). Otherwise [].

EAR RULES (hard):
- Never say URLs, absolute file paths, hashes, or percent-of-context-window numbers. Say "a link", the bare file name ("styles dot css"), "an id".
- Never reproduce terminal sequences, ASCII art, source code, raw markdown, isolated symbols, or symbol-heavy model/session identifiers. Translate them into the human outcome.
- Keep EXACT names that carry the decision: command names, error names, branch names, dollar amounts, test counts.
- Round big numbers ("about three hundred files"). Spell acronyms only if ambiguous.
- Plain sentences, active voice, no markdown, no emoji, no bullet characters. Numbers as digits are fine.
- The three levels must each stand alone (don't say "as I said").
- If the supervisor flagged a hold/escalation, lead with that in standard and detail.
- Never invent: if the context doesn't say it, don't say it.`;

export function buildBriefUserText({ project, tool, category, originalRequest, latestReport, summary, ask, supervisorNote }) {
  const original = sanitizeForSpeech(originalRequest || '');
  const latest = sanitizeForSpeech(latestReport || ask || summary || '');
  const parts = [
    `PROJECT: ${project || 'adhoc'} · AGENT: ${tool || 'cli'} · QUEUE CATEGORY: ${category || 'review'}`,
    original ? `ORIGINAL REQUEST:\n${original}` : '',
    latest ? `LATEST REPORT:\n${latest}` : '',
    supervisorNote ? `SUPERVISOR:\n${sanitizeForSpeech(supervisorNote)}` : '',
  ].filter(Boolean);
  return parts.join('\n\n').slice(0, 7000);
}

export function validateBrief(o) {
  if (!o || typeof o !== 'object') return null;
  const kinds = ['decision', 'input', 'discussion', 'review', 'blocked', 'progress'];
  const clamp = (s, n) => {
    let t = sanitizeForSpeech(String(s || ''));
    if (t.length <= n) return t;
    t = t.slice(0, n - 1); // room for the ellipsis
    const cut = t.lastIndexOf(' ');
    return (cut > n * 0.6 ? t.slice(0, cut) : t).replace(/[,;:—-]$/, '') + '…'; // never end mid-word
  };
  const brief = {
    topic: clamp(o.topic, 60) || 'agent update',
    kind: kinds.includes(o.kind) ? o.kind : 'review',
    request: clamp(o.request, 320),
    updates: (Array.isArray(o.updates) ? o.updates : []).slice(0, 6).map((item) => ({
      requested: clamp(item?.requested, 100),
      latest: clamp(item?.latest, 260),
    })).filter((item) => item.requested && item.latest),
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

export async function buildVoiceBrief({ sessionId, project, tool, category, originalRequest, latestReport, summary, ask, screen, supervisorNote, call = null }) {
  const cleanOriginal = sanitizeForSpeech(originalRequest || '');
  const cleanLatest = sanitizeForSpeech(latestReport || ask || summary || '');
  const user = buildBriefUserText({
    project,
    tool,
    category,
    originalRequest: cleanOriginal,
    latestReport: cleanLatest,
    summary,
    ask,
    supervisorNote,
  });
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
    if (brief) {
      if (!brief.request) brief.request = cleanOriginal.slice(0, 320);
      if (!brief.updates.length && cleanLatest) {
        brief.updates = [{
          requested: (brief.request || brief.topic || 'the request').slice(0, 100),
          latest: cleanLatest.slice(0, 260),
        }];
      }
    }
  } catch {}
  if (!brief) {
    // fail-open: a sanitized template beats silence
    const gist = cleanLatest.replace(/\s+/g, ' ').slice(0, 260);
    const request = cleanOriginal.replace(/\s+/g, ' ').slice(0, 320);
    brief = {
      topic: `${project || tool} update`,
      kind: category === 'decision' ? 'decision' : category === 'action' ? 'input' : 'review',
      request,
      updates: gist ? [{ requested: (request || 'the request').slice(0, 100), latest: gist }] : [],
      quick: gist.slice(0, 140),
      standard: gist,
      detail: gist,
      needs: '',
      options: [],
    };
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

export function speakOnTheGoBrief(brief) {
  const clause = (value) => sanitizeForSpeech(value).replace(/[.!?]+$/, '').trim();
  const request = clause(brief?.request || '');
  const updates = (brief?.updates || []).slice(0, 6);
  const latest = updates.length
    ? updates.map((item) => updates.length === 1
      ? `The latest report says: ${clause(item.latest)}.`
      : `For ${clause(item.requested)}, ${clause(item.latest)}.`).join(' ')
    : brief?.standard
      ? `The latest report says: ${clause(brief.standard)}.`
      : '';
  const needs = brief?.needs ? `What needs you now: ${clause(brief.needs)}.` : '';
  const options = brief?.options?.length
    ? `Your choices are ${brief.options.map((option) => clause(option.spoken || option.label)).join(', or ')}.`
    : '';
  return [
    "Here's what happened.",
    request ? `Your original request was: ${request}.` : '',
    latest,
    needs,
    options,
  ].filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();
}
