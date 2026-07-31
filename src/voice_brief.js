// Spoken briefs for coding-agent sessions (phone + desktop voice).
// Automatic reports are grounded in the operator's original request and the latest curated attention
// report. Raw terminal tails are intentionally excluded: source code, TUI chrome, and transient
// symbols are useful for inspection but make terrible spoken conversation.

import { chat } from './llm.js';

const BRIEF_CHAIN = String(process.env.AIOS_VOICE_BRIEF_CHAIN
  || '8789:claude-opus-5,8788:gpt-5.6-luna,8792:qwen36-a3b-nvfp4-marlin')
  .split(',')
  .map((entry) => {
    const [port, ...model] = entry.trim().split(':');
    return { port: Number(port), model: model.join(':') };
  })
  .filter((entry) => Number.isFinite(entry.port) && entry.model);

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
    // Compact agent-plan counters are visual UI, not prose ("✔ task … +23 completed new task?").
    // Preserve the useful count in words while dropping checkmarks and composer prompts.
    .replace(/[✔✓]\s*/g, '')
    .replace(/(?:…|\.\.\.)?\s*\+(\d+)\s+completed\b/gi, '. $1 more items completed.')
    .replace(/\bnew task\??\b/gi, ' ')
    .replace(/[│┃┆┊┌┐└┘├┤┬┴┼╭╮╰╯─━]+/g, ' ')
    .replace(/[#*`_{}[\]<>\\|~^]+/g, ' ')
    .replace(/(?:-{3,}|={3,})/g, ' ')
    .replace(/(^|\s)(?:=>|->|::|&&|\|\||[+>=]{1,2})(?=\s|$)/g, '$1 ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export const SYS_BRIEF = `You prepare SPOKEN briefs of coding-agent sessions for the PROJECT OWNER. Act like a trusted project lead calling with a useful update, not a robot reading fields. The owner already knows what their project is. Never explain the product, its mission, architecture, host, or general purpose. Instead, orient them to the exact work thread using this hierarchy: project/repository identity, module or feature, current workstream, then what happened to the requested update. The listener must quickly understand which work this is, what they asked for, what materially happened, why it matters, and the one response—if any—that moves work forward. You receive the current task contract, recent operator/agent conversation, the latest curated report, and supervisor notes.

Return STRICT minified JSON only, no fences:
{"topic":"<=6 words, the subject as a spoken title","kind":"decision|input|discussion|review|blocked|progress","identity":"the supplied project/repository identity, unchanged","module":"<=6 words: the module, feature, or product area under discussion","workstream":"<=8 words: the specific improvement, bug, or outcome being worked on","request":"<=35 words: natural spoken restatement of the CURRENT operator request/task contract","updates":[{"requested":"<=10 words: one distinct thing the operator requested","latest":"<=28 words: latest reported outcome or need for that thing"}],"quick":"<=20 words: the single most consequential change and why the listener is being interrupted","standard":"<=55 words: prioritize outcomes, risk, and unresolved work; omit implementation trivia","options":[{"key":"1","label":"short label","spoken":"how you'd say this choice in <=10 words"}],"needs":"one sentence: exactly what input unblocks the agent; empty when no human input is actually required","spoken":"<=65 words: the natural phone update AFTER the orientation: what the owner asked; what materially happened; why it matters; exactly what response is needed. Do not repeat identity, module, or workstream. No product explanation and no labels such as ORIGINAL REQUEST or LATEST REPORT"}
Return exactly these keys and no others. The entire JSON response must be under 500 tokens.

SOURCE PRIORITY:
- CURRENT TASK CONTRACT and RECENT CONVERSATION define the current request. The first-ever session prompt may be stale after follow-up requests.
- LATEST REPORT says what happened. Build one updates entry for EACH distinct requested deliverable that the latest report addresses, up to 3.
- RECENT CONVERSATION resolves pronouns, corrections, follow-up requests, and what the agent has already explained.
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
- Judge importance like a human project lead: lead with a blocker, failed verification, irreversible choice, user-visible behavior, or completed outcome. Do not narrate file edits, internal plumbing, or test mechanics unless they change the decision or confidence.
- Do not claim the agent needs feedback merely because its run ended. A finished report can ask for review; a progress report can require nothing.
- The system adds the identity/module/workstream orientation before "spoken", so do not repeat it there. "spoken" must sound conversational and specific. Do not define the project or tell its owner what it does.
- Avoid repetitive field labels, generic phrases such as "the latest report says," and unsupported praise.
- Never invent: if the context doesn't say it, don't say it.`;

export function buildBriefUserText({
  project,
  projectIdentity,
  tool,
  category,
  taskContext,
  recentConversation,
  originalRequest,
  latestReport,
  summary,
  ask,
  supervisorNote,
}) {
  const original = sanitizeForSpeech(originalRequest || '');
  const latest = sanitizeForSpeech(latestReport || ask || summary || '');
  const parts = [
    `PROJECT / REPOSITORY IDENTITY: ${projectIdentity || project || 'adhoc'} · AGENT: ${tool || 'cli'} · QUEUE CATEGORY: ${category || 'review'}`,
    taskContext ? `CURRENT TASK CONTRACT:\n${sanitizeForSpeech(taskContext)}` : '',
    recentConversation ? `RECENT CONVERSATION (oldest to newest):\n${sanitizeForSpeech(recentConversation)}` : '',
    original ? `ORIGINAL REQUEST:\n${original}` : '',
    latest ? `LATEST REPORT:\n${latest}` : '',
    supervisorNote ? `SUPERVISOR:\n${sanitizeForSpeech(supervisorNote)}` : '',
  ].filter(Boolean);
  return parts.join('\n\n').slice(0, 12000);
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
    identity: clamp(o.identity || o.project, 100),
    module: clamp(o.module, 80),
    workstream: clamp(o.workstream, 110),
    request: clamp(o.request, 320),
    updates: (Array.isArray(o.updates) ? o.updates : []).slice(0, 6).map((item) => ({
      requested: clamp(item?.requested, 100),
      latest: clamp(item?.latest, 260),
    })).filter((item) => item.requested && item.latest),
    quick: clamp(o.quick, 160),
    standard: clamp(o.standard, 420),
    spoken: clamp(o.spoken, 720),
    detail: clamp(o.detail, 1200),
    needs: clamp(o.needs, 160),
    options: (Array.isArray(o.options) ? o.options : []).slice(0, 4).map((x) => ({
      key: String(x?.key || '').slice(0, 3),
      label: String(x?.label || '').slice(0, 40),
      spoken: clamp(x?.spoken || x?.label, 90),
    })).filter((x) => x.key && x.label),
  };
  if (!brief.standard) return null;
  if (!brief.quick) brief.quick = brief.standard.slice(0, 140);
  if (!brief.spoken) brief.spoken = brief.standard;
  if (/^(?:no|none|nothing)\b.{0,80}\b(?:input|decision|response).{0,30}\b(?:needed|required|necessary)\b/i.test(brief.needs)) brief.needs = '';
  return brief;
}

const cache = new Map(); // `${sid}|${hash}` -> brief (in-memory; regenerates after restart)
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

export async function buildVoiceBrief({
  sessionId,
  project,
  projectIdentity,
  tool,
  category,
  projectContext,
  taskContext,
  recentConversation,
  originalRequest,
  latestReport,
  summary,
  ask,
  screen,
  supervisorNote,
  call = null,
}) {
  const cleanOriginal = sanitizeForSpeech(originalRequest || '');
  const cleanLatest = sanitizeForSpeech(latestReport || ask || summary || '');
  const user = buildBriefUserText({
    project,
    projectIdentity,
    tool,
    category,
    taskContext,
    recentConversation,
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
    // Use the same direct, subscription-aware fleet chain as the conversational voice brain.
    // Resolving a catalog model here selected its API-provider twin and could 403 even while the live
    // CLI/fleet route was healthy, silently degrading every briefing to the robotic fallback.
    const out = await chat(
      [{ role: 'system', content: sys }, { role: 'user', content: u }],
      // Opus 5 rejects the legacy temperature option; its default is already appropriate for a
      // grounded structured brief. Omitting it also keeps the route compatible with older fallbacks.
      { max_tokens: 800, timeout_ms: 14000 },
      BRIEF_CHAIN,
    );
    return out.content;
  });
  try {
    const raw = await invoke(SYS_BRIEF, user);
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    brief = validateBrief(m ? JSON.parse(m[0]) : null);
    if (brief) {
      if (!brief.request) brief.request = cleanOriginal.slice(0, 320);
      if (!brief.identity) brief.identity = sanitizeForSpeech(projectIdentity || project || 'adhoc').slice(0, 100);
      if (!brief.updates.length && cleanLatest) {
        brief.updates = [{
          requested: (brief.request || brief.topic || 'the request').slice(0, 100),
          latest: cleanLatest.slice(0, 260),
        }];
      }
      if (!brief.spoken) {
        brief.spoken = [
          [brief.identity, brief.module, brief.workstream].filter(Boolean).join('. '),
          brief.request ? `You asked me to ${brief.request.replace(/^[Yy]ou (?:asked|wanted)(?: me)? to\s+/i, '')}` : '',
          brief.standard,
          brief.needs,
        ].filter(Boolean).join(' ');
      }
    }
  } catch {}
  if (!brief) {
    // fail-open: a sanitized template beats silence
    const sentence = (value, max) => sanitizeForSpeech(value).replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '').slice(0, max);
    const gist = sentence(cleanLatest, 260);
    const request = sentence(cleanOriginal, 320);
    const need = ['decision', 'action'].includes(category) ? sentence(ask || summary, 160) : '';
    brief = {
      topic: `${project || tool} update`,
      kind: category === 'decision' ? 'decision' : category === 'action' ? 'input' : 'review',
      identity: sentence(projectIdentity || project || 'adhoc', 100),
      module: '',
      workstream: sentence(request || gist, 110),
      request,
      updates: gist ? [{ requested: (request || 'the request').slice(0, 100), latest: gist }] : [],
      quick: gist.slice(0, 140),
      standard: gist,
      spoken: [
        sentence(projectIdentity || project || 'adhoc', 100),
        request ? `You asked: ${request}` : '',
        gist ? `Here is what changed: ${gist}` : '',
        need ? `What I need from you: ${need}` : '',
      ].filter(Boolean).join('. ').replace(/([.!?])\./g, '$1').slice(0, 720),
      detail: gist,
      needs: need,
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

function spokenLimit(value, maxWords) {
  const clean = sanitizeForSpeech(value).replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim();
  const words = clean.split(' ').filter(Boolean);
  if (words.length <= maxWords) return clean;
  return words.slice(0, maxWords).join(' ').replace(/[,;:—-]$/, '') + '…';
}

export function speakOnTheGoBrief(brief) {
  // Orientation is deterministic rather than entrusted to prose generation: the project owner always
  // hears identity → module → workstream before the model's prioritized update.
  const orientation = spokenLimit([brief?.identity, brief?.module, brief?.workstream].filter(Boolean).join('. '), 22);
  const integrated = spokenLimit(brief?.spoken, 68);
  if (integrated) return [orientation ? `${orientation}.` : '', integrated].filter(Boolean).join(' ');
  const request = spokenLimit(brief?.request, 22);
  const latest = spokenLimit(brief?.quick || brief?.standard || brief?.updates?.[0]?.latest, 28);
  const needs = spokenLimit(brief?.needs, 18);
  const options = brief?.options?.length
    ? `Choices: ${brief.options.slice(0, 3).map((option) => spokenLimit(option.spoken || option.label, 7)).join(', or ')}.`
    : '';
  return [
    orientation,
    request ? `You asked: ${request}.` : '',
    latest ? `Here is what changed: ${latest}.` : '',
    needs ? `${needs}.` : '',
    options,
  ].filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();
}
