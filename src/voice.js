import { route, json, readJson } from './server.js';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as store from './store.js';
import * as sessions from './sessions.js';
import { chat } from './llm.js';
import { id, now, stripAnsi } from './util.js';
import { buildVoiceBrief, speakBrief, speakOnTheGoBrief, sanitizeForSpeech } from './voice_brief.js';
import { listWiki, readWiki, searchWiki } from './wiki.js';
import { getContext } from './context_doc.js';
import { getRuntime, listEvents as listProjectEvents, taskCard } from './agents/supervisor/project_memory.js';
import { storyFor } from './story_api.js';
import { attentionUnreadCount, getAttentionDismissal } from './attention_store.js';
import { asksForSessionOverview, isNeedsYouSession, originalRequestFrom } from './voice_attention.js';
import {
  asksForConfirmation,
  confirmedPendingReply,
  isVoiceInformationQuestion,
  normalizeVoiceAddress,
  parseVoiceBrainOutput,
  voiceControlReply,
  providerFailureReply,
} from './voice_turn.js';
import { deliverVoiceFeedback } from './voice_delivery.js';

// Hands-free voice concierge: walk the needs-you queue oldest-first, converse about
// each item, confirm, and send the user's instruction to the CLI agent. The brain is
// the llm.js fallback chain. The browser handles TTS playback + STT (with VAD).

export const VOICE_SYSTEM_PROMPT = `You are Supercalm Voice Assistant, a hands-free project lead. You help the project owner understand and clear a queue of coding-agent sessions waiting on them; you SPEAK and they reply by voice. Sound like an intelligent human colleague on a phone call: grounded, specific, calm, and concise. The owner already knows what their project is, so never explain the product or mission unless explicitly asked. Orient every answer to the exact work thread: project/repository identity, module or feature, and current improvement. Normally use 2-4 short spoken sentences. If the user explicitly asks for all/each session status, give one plain short clause per relevant session, up to about 120 words. No markdown, no code, no URLs, no emoji; keep key technical terms but phrase them for the ear.
For the user's reply about the CURRENT item:
- an instruction for the agent -> restate its core in one sentence and ask them to confirm (action "await"); put the clear actionable draft in "message" even though it is not sent yet.
- a confirmation (yes/go/send/correct) -> action "send", with "message" = a clear actionable instruction that captures their intent.
- asks for detail or your opinion -> answer briefly, stay here (action "await").
- asks a QUESTION about the session, the project, or what the supervisor thinks -> answer from CONTEXT (recent messages, screen, PROJECT KNOWLEDGE, SUPERVISOR notes) in 1-2 spoken sentences, then action "await". If the context doesn't contain the answer, say so plainly — never invent. Never speak URLs or file paths; use bare file names.
- in a follow-up such as "tell me about this", "what happened here", or "why", "this" means the current update/workstream—not the product in general. Answer the useful detail behind the report.
- a correction such as "I was asking for details" means answer the earlier question; it is NEVER feedback to send to the coding agent.
- skip / pass / later / next -> action "next".
- stop / done / that's all -> action "stop".
- speech that is clearly unrelated to this report or sounds like a nearby third-party conversation -> action "ignore", with empty "say" and "message".
Default to "await" for any NEW instruction — confirm before acting. Only use "send" after the system has already restated an instruction and the user confirms it (yes / go / correct / send it). When unsure between await and send, choose await.
On "send" or "next", briefly confirm and say you're moving on — do NOT describe or invent the next item; the system presents it on the next turn.
When asked to PRESENT an item: say what its agent needs and ask what they want to do; mention the count only at the very start. Ignore any greyed composer placeholder hint (e.g. "Explain this codebase") — it is not a real task.
Do not mention other sessions, stopped work, or general system status unless the user explicitly asks for a session overview.
Reply with STRICT minified JSON ONLY, no fences: {"say":"...","action":"await|send|next|stop|ignore","message":"...draft when awaiting confirmation, final instruction when sending..."}`;

const voiceSessions = new Map();
const VOICE_TTL_MS = 30 * 60 * 1000;
const TURN_BUDGET_MS = Number(process.env.AIOS_VOICE_TURN_BUDGET_MS || 18000); // must stay well inside the client's 30s /turn abort
const CONVERSATION_CHAIN = String(process.env.AIOS_VOICE_CONVERSATION_CHAIN
  || '8789:claude-opus-5,8788:gpt-5.6-luna,8792:qwen36-a3b-nvfp4-marlin')
  .split(',')
  .map((entry) => {
    const [port, ...model] = entry.trim().split(':');
    return { port: Number(port), model: model.join(':') };
  })
  .filter((entry) => Number.isFinite(entry.port) && entry.model);
const trim = (h) => { while (h.length > 16) h.shift(); };
const touch = (vs) => { vs.lastTouch = now(); };
// Lazy expiry keyed on LAST TOUCH, run on every voice endpoint — a createdAt-based sweep would kill
// a live long pass mid-conversation, and a timer-only sweep left abandoned sessions until the next /start.
function gcVoiceSessions() {
  for (const [k, v] of voiceSessions) if (now() - (v.lastTouch || v.createdAt) > VOICE_TTL_MS) voiceSessions.delete(k);
}
const cur = (vs) => {
  const it = vs.items[vs.pointer];
  return it ? {
    sessionId: it.sessionId,
    project: it.project,
    projectIdentity: it.projectIdentity || it.project,
    module: it.module || '',
    workstream: it.workstream || '',
    tool: it.tool,
    category: it.category,
    n: vs.pointer + 1,
    total: vs.items.length,
  } : null;
};
// Did anyone else answer this session since we presented it? (dashboard reply, another device…)
// A voice reply dictated against an old prompt must not land on top of someone else's answer.
function answeredElsewhereSince(sessionId, sinceTs) {
  try {
    const r = store.db.prepare("SELECT COUNT(*) c FROM messages WHERE session_id = ? AND direction = 'in' AND ts > ? AND (source IS NULL OR source != 'voice')").get(sessionId, sinceTs || 0);
    return (r?.c || 0) > 0;
  } catch { return false; }
}

function attentionState(session) {
  const unread = attentionUnreadCount(session.id);
  const dismissal = getAttentionDismissal(session.id);
  return { unread, dismissed: !!dismissal };
}

function stillNeedsAttention(sessionId) {
  const session = store.getSession(sessionId);
  return isNeedsYouSession(session, session ? attentionState(session) : {});
}

function latestReportFor(session) {
  const summary = String(session?.summary || '').trim();
  const question = String(session?.question || '').trim();
  if (!summary) return question;
  if (!question || summary === question || question.includes(summary)) return question || summary;
  if (summary.includes(question)) return summary;
  return `${summary}. ${question}`;
}

export function projectIdentityFor(project) {
  if (!project) return 'adhoc';
  const names = [];
  const add = (value) => {
    const name = String(value || '').trim();
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (key && !names.some((existing) => existing.toLowerCase().replace(/[^a-z0-9]+/g, '') === key)) names.push(name);
  };
  add(project.name);
  if (project.path) {
    const packageFile = join(project.path, 'package.json');
    if (existsSync(packageFile)) {
      try { add(JSON.parse(readFileSync(packageFile, 'utf8')).name); } catch {}
    }
    add(basename(project.path));
  }
  return names.slice(0, 2).join('/') || 'adhoc';
}

export function buildVoiceItems(focusSessionId = '', { onTheGo = false } = {}) {
  const live = store
    .listLiveSessions()
    .filter((s) => isNeedsYouSession(s, attentionState(s)))
    .sort((a, b) => {
      // An on-the-go notification names the report that just arrived. Present that project first
      // instead of making the operator listen through an older queue before hearing the new update.
      if (focusSessionId) {
        if (a.id === focusSessionId && b.id !== focusSessionId) return -1;
        if (b.id === focusSessionId && a.id !== focusSessionId) return 1;
      }
      return (a.last_activity || 0) - (b.last_activity || 0);
    }); // otherwise oldest waiting first
  return live.map((s) => {
    const messages = store.messagesFor(s.id, 200);
    const project = s.project_id ? store.getProject(s.project_id) : null;
    return {
      sessionId: s.id,
      tmux: s.tmux,
      tool: s.tool,
      projectId: s.project_id || null,
      project: project?.name || 'adhoc',
      projectIdentity: projectIdentityFor(project),
      originalRequest: originalRequestFrom(messages, s.title || ''),
      latestReport: latestReportFor(s),
      summary: s.summary || s.question || '',
      category: s.category || 'review',
      onTheGo,
    };
  });
}

function supervisorNoteFor(sessionId) {
  try {
    const g = store.getGrant(sessionId, 'supervisor');
    if (!g?.enabled) return '';
    const st = g.state || {};
    const parts = [];
    if (st.needsOperatorHold) parts.push(`HOLD needs you: ${String(st.needsOperatorHold.reason || '').slice(0, 160)}`);
    if (st.pendingBoundary) parts.push(`suggests a new task card: ${String(st.pendingBoundary.title || '').slice(0, 80)}`);
    try {
      const r = store.db.prepare("SELECT verdict, substr(assessment,1,180) a FROM supervisor_reviews WHERE session_id = ? AND kind IN ('verify','gate','escalate') ORDER BY ts DESC LIMIT 1").get(sessionId);
      if (r) parts.push(`latest review: ${r.verdict} — ${r.a}`);
    } catch {}
    return parts.join(' · ');
  } catch { return ''; }
}

function readProjectOverview(project) {
  if (!project?.id) return '';
  const parts = [];
  try {
    const pages = listWiki(project.id);
    const overview = pages.find((page) => /(?:^|\/)overview\.md$/i.test(page.path))
      || pages.find((page) => /overview|about|architecture/i.test(`${page.title || ''} ${page.path || ''}`));
    const page = overview ? readWiki(project.id, overview.path) : null;
    if (page?.content) parts.push(String(page.content).slice(0, 2400));
  } catch {}
  try {
    const context = getContext(project.id);
    if (context?.doc) parts.push(String(context.doc).slice(0, 2200));
  } catch {}
  if (!parts.length && project.path) {
    for (const name of ['README.md', 'readme.md', 'README']) {
      const file = join(project.path, name);
      if (!existsSync(file)) continue;
      try { parts.push(readFileSync(file, 'utf8').slice(0, 2400)); } catch {}
      break;
    }
  }
  return sanitizeForSpeech(parts.join('\n')).slice(0, 3200);
}

function currentTaskContext(sessionId) {
  try {
    const runtime = getRuntime(sessionId);
    const card = runtime?.active_task_id ? taskCard(runtime.active_task_id) : null;
    if (!card?.task) return '';
    const lines = [
      `${card.task.title || 'Current task'} (${card.task.status})`,
      card.task.goal ? `Goal: ${card.task.goal}` : '',
      ...card.criteria.slice(0, 10).map((criterion) => `${criterion.status === 'satisfied' ? 'Already verified' : 'Still required'}: ${criterion.text}`),
    ].filter(Boolean);
    const events = listProjectEvents({ projectId: card.task.project_id, taskId: card.task.id, limit: 6 }).reverse();
    if (events.length) {
      lines.push('Recent task record:');
      for (const event of events) lines.push(`${event.type}: ${event.summary}`);
    }
    return sanitizeForSpeech(lines.join('\n')).slice(0, 4000);
  } catch {
    return '';
  }
}

function storyConversation(events) {
  const relevant = (events || []).filter((event) => ['you', 'report', 'ask', 'fail', 'plan'].includes(event?.kind)).slice(-18);
  const lines = [];
  for (const event of relevant) {
    if (event.kind === 'you') lines.push(`Operator: ${event.body || event.text || ''}`);
    else if (event.kind === 'report') lines.push(`Agent report: ${event.body || event.text || ''}`);
    else if (event.kind === 'ask') {
      const options = (event.options || []).map((option) => option.label || option.description || option).filter(Boolean).join(' or ');
      lines.push(`Agent needs a decision: ${event.body || event.text || event.title || ''}${options ? `. Choices: ${options}` : ''}`);
    } else if (event.kind === 'fail') lines.push(`Problem encountered: ${event.body || event.text || event.title || ''}`);
    else if (event.kind === 'plan') {
      const items = (event.planItems || []).map((item) => item.step || item.content || item.text).filter(Boolean).slice(0, 6);
      if (items.length) lines.push(`Plan: ${items.join('; ')}`);
    }
  }
  return sanitizeForSpeech(lines.join('\n')).slice(0, 6500);
}

export async function voiceEvidenceFor(it) {
  if (!it) return { projectContext: '', taskContext: '', recentConversation: '' };
  if (it._evidence) return it._evidence;
  if (it._evidencePromise) return it._evidencePromise;
  it._evidencePromise = (async () => {
    const session = store.getSession(it.sessionId);
    const project = session?.project_id ? store.getProject(session.project_id) : null;
    let recentConversation = '';
    try {
      const story = await storyFor(it.sessionId, { rounds: 4 });
      recentConversation = storyConversation(story?.events);
    } catch {}
    return {
      projectContext: readProjectOverview(project),
      taskContext: currentTaskContext(it.sessionId),
      recentConversation,
    };
  })();
  try {
    it._evidence = await it._evidencePromise;
    return it._evidence;
  } finally {
    it._evidencePromise = null;
  }
}

async function stateContext(vs, userText = '') {
  const it = vs.items[vs.pointer];
  const lines = [`You are on item ${vs.pointer + 1} of ${vs.items.length}.`];
  if (it) {
    lines.push(`CURRENT WORK THREAD: ${it.projectIdentity || it.project} · ${it.module || 'current module'} · ${it.workstream || it.category} · ${it.tool}.`);
    if (it.originalRequest) lines.push(`ORIGINAL REQUEST: ${sanitizeForSpeech(it.originalRequest).slice(0, 1200)}`);
    if (it.latestReport) lines.push(`LATEST REPORT: ${sanitizeForSpeech(it.latestReport).slice(0, 1200)}`);
    const evidence = await voiceEvidenceFor(it);
    if (evidence.projectContext) lines.push(`PROJECT BACKGROUND:\n${evidence.projectContext}`);
    if (evidence.taskContext) lines.push(`CURRENT TASK CONTRACT:\n${evidence.taskContext}`);
    if (evidence.recentConversation) lines.push(`RECENT CONVERSATION:\n${evidence.recentConversation}`);
    const msgs = store.messagesFor(it.sessionId, 200).slice(-4);
    if (msgs.length) {
      lines.push('Recent:');
      for (const m of msgs) lines.push(`  ${m.direction === 'in' ? 'you' : 'agent'}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    let snap = '';
    try {
      snap = stripAnsi(await sessions.snapshot(it.sessionId)).split('\n').map((l) => l.trim()).filter(Boolean).slice(-8).join('\n');
    } catch {}
    if (snap) lines.push('Screen:', sanitizeForSpeech(snap).slice(-700));
    const supNote = supervisorNoteFor(it.sessionId);
    if (supNote) lines.push('SUPERVISOR: ' + supNote);
    // RAG for in-between questions: the project knowledge base, scoped to what the user just asked
    if (userText && userText.length > 8) {
      try {
        const sess = store.getSession(it.sessionId);
        const hits = sess?.project_id ? searchWiki(sess.project_id, userText, 2) : [];
        if (hits.length) {
          lines.push('PROJECT KNOWLEDGE (descriptive reference):');
          for (const h of hits) lines.push(`  [${h.path}] ${String(h.snippet).replace(/\s+/g, ' ').slice(0, 220)}`);
        }
      } catch {}
    }
  }
  // A broad status dump is distracting during an attention pass. Add it to the LLM context only
  // when the operator actually asks for all/other/new session status.
  if (asksForSessionOverview(userText)) {
    lines.push('SESSION OVERVIEW (included only because the operator explicitly asked):');
    for (const session of store.listSessions().slice(0, 24)) {
      const state = attentionState(session);
      const status = isNeedsYouSession(session, state)
        ? 'Needs You'
        : state.dismissed
          ? 'dismissed from Needs You'
          : session.status;
      const project = session.project_id ? store.getProject(session.project_id)?.name || 'adhoc' : 'adhoc';
      lines.push(`  ${project}, ${session.tool}: ${status}. ${sanitizeForSpeech(session.title || '').slice(0, 100)}`);
    }
  }
  return lines.join('\n');
}

// Present the current item with a TEMPLATE (no LLM call). The clean summary was already
// computed at waiting-time, so we skip the ~1.5s brain round-trip and go straight to TTS —
// the only remaining wait before speaking is neural generation. (The brain is still used
// for the conversational REPLIES in brainReply.)
async function briefFor(it) {
  if (!it) return null;
  if (it._brief) return it._brief;
  try {
    const s2 = store.getSession(it.sessionId);
    const evidence = await voiceEvidenceFor(it);
    it._brief = await buildVoiceBrief({
      sessionId: it.sessionId, project: it.project, projectIdentity: it.projectIdentity, tool: it.tool, category: it.category,
      ...evidence,
      originalRequest: it.originalRequest,
      latestReport: it.latestReport || latestReportFor(s2),
      summary: it.summary, ask: s2?.question || '', screen: '', supervisorNote: supervisorNoteFor(it.sessionId),
    });
    if (it._brief) {
      it.module = it._brief.module || '';
      it.workstream = it._brief.workstream || '';
    }
  } catch { it._brief = null; }
  return it._brief;
}
function prefetchBriefs(vs) {
  for (const it of vs.items.slice(0, 4)) briefFor(it).catch(() => {}); // fire-and-forget: item 2+ speak instantly
}

async function present(vs, greet) {
  const it = vs.items[vs.pointer];
  let say;
  if (!it) {
    say = greet ? 'You have nothing waiting right now. All caught up.' : 'What next?';
  } else {
    const n = vs.items.length;
    const where = it.projectIdentity && it.projectIdentity !== 'adhoc' ? it.projectIdentity : it.tool;
    const lead = greet
      ? vs.onTheGo
        ? `New Needs You update.`
        : `You have ${n} ${n > 1 ? 'items' : 'item'} in Needs You. First up, ${where}.`
      : vs.onTheGo ? 'Next update.' : `Next, ${where}.`;
    // A grounded project-lead brief is worth a short pause. The local briefing model normally returns
    // in about 11 seconds; 14 seconds keeps /start inside the client's 30-second bound while avoiding
    // the robotic template on every first presentation.
    const brief = await Promise.race([briefFor(it), new Promise((r) => setTimeout(() => r(null), 14000))]);
    if (brief) {
      if (vs.onTheGo) {
        say = `${lead} ${speakOnTheGoBrief(brief)} ${brief.needs ? '' : 'What would you like to do?'}`.trim();
      } else {
        say = `${lead} ${speakBrief(brief, { level: 'standard' })} ${brief.needs ? '' : 'What would you like to do?'}`.trim();
        if (brief.needs && !brief.options?.length) say += ` ${brief.needs}`;
      }
    } else {
      let request = sanitizeForSpeech(it.originalRequest).replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
      let latest = sanitizeForSpeech(it.latestReport || it.summary).replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
      const requestCap = vs.onTheGo ? 90 : 150;
      const latestCap = vs.onTheGo ? 120 : 180;
      if (request.length > requestCap) request = request.slice(0, requestCap).replace(/\s+\S*$/, '') + '…';
      if (latest.length > latestCap) latest = latest.slice(0, latestCap).replace(/\s+\S*$/, '') + '…';
      say = vs.onTheGo
        ? `${lead} ${request ? `You asked: ${request}.` : ''} ${latest ? `Update: ${latest}.` : ''} What would you like the agent to do?`
        : `${lead} Here's what happened. ${request ? `You originally asked: ${request}.` : ''} ${latest ? `The latest report says: ${latest}.` : ''} What would you like to do?`;
    }
  }
  return say;
}

// Advance to the next item that is STILL live and present it. Items resolve out from under a pass
// constantly (answered from the dashboard, another device, or the agent moved on) — presenting a
// snapshot blind risked sending a reply into a session that no longer asked anything. Re-checks once
// more AFTER the brief wait (status can flip while it is generated). Pushes the final spoken line into the
// brain history exactly once, only for what was actually said.
async function presentNext(vs, greet) {
  let skipped = 0;
  for (;;) {
    while (vs.pointer < vs.items.length && !stillNeedsAttention(vs.items[vs.pointer].sessionId)) {
      vs.pointer++; skipped++;
    }
    if (vs.pointer >= vs.items.length) return { ended: true, skipped };
    const it = vs.items[vs.pointer];
    const say = await present(vs, greet);
    if (stillNeedsAttention(it.sessionId)) {
      it.presentedAt = now();
      const lead = skipped ? (skipped === 1 ? 'One item got handled in the meantime. ' : `${skipped} items got handled in the meantime. `) : '';
      const full = lead + say;
      vs.history.push({ role: 'assistant', content: full });
      trim(vs.history);
      return { ended: false, say: full, skipped };
    }
    vs.pointer++; skipped++; // went stale while the brief generated — move on
  }
}

async function brainReply(vs, userText) {
  // Hard total budget: the client aborts /turn at 30s — without a bound here the chain's worst case
  // (3+ models × 45s socket timeouts) outlived the client, and a 'send' computed after the client
  // gave up was still typed into the agent (double-send on the retry pass). Timeout → preserve what
  // the operator said and offer a deterministic "send it" next step; never blame their speech for
  // an upstream model/provider failure.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TURN_BUDGET_MS);
  try {
    const ctx = await stateContext(vs, userText);
    const { content } = await chat(
      // /turn records the current transcript in history before calling us. Appending userText again
      // made every spoken turn appear twice to the model, with two consecutive user roles; this was
      // especially confusing on the confirmation turn.
      [{ role: 'system', content: VOICE_SYSTEM_PROMPT + '\n\n' + ctx }, ...vs.history],
      { max_tokens: 650, timeout_ms: 12000, signal: ac.signal },
      CONVERSATION_CHAIN,
    );
    const obj = parseVoiceBrainOutput(content, userText);
    let action = ['await', 'send', 'next', 'stop', 'ignore'].includes(obj.action) ? obj.action : 'await';
    let say = sanitizeForSpeech(String(obj.say || '')).trim();
    let message = obj.message ? String(obj.message) : '';
    // An STT transcript often loses question punctuation. This deterministic semantic guard covers
    // explicit detail/status/opinion questions and "I was asking..." corrections even if a model
    // violates the JSON policy: questions stay in the conversation and can never become agent input.
    if (isVoiceInformationQuestion(userText) && ['send', 'ignore'].includes(action)) {
      action = 'await';
      message = '';
      if (/\b(?:send|forward|pass)(?:ing|ed)?\b.{0,35}\b(?:agent|session|feedback)\b/i.test(say)) {
        say = "I understood that as a question, so I didn't send it to the agent. I don't yet have a reliable answer from the available context.";
      }
    }
    // Voice updates and manually-started Voice use the same deliberate delivery contract: a new
    // instruction is restated first, and only a later confirmation crosses into the coding session.
    // This is also the last safety boundary against nearby conversation that sounded task-related.
    if (action === 'send' && !vs.pendingInstruction) {
      action = 'await';
      message = message || userText;
      say = say && !/\b(?:sent|forwarded|passed)\b/i.test(say)
        ? say
        : `I understood that as: ${sanitizeForSpeech(message).slice(0, 220)}. Should I send that to the agent?`;
    }
    if (action !== 'ignore' && !say) say = 'Okay.';
    return {
      say,
      action,
      message,
    };
  } catch (e) {
    console.error('[aios] voice reply failed:', e.message);
    const it = vs.items[vs.pointer];
    if (isVoiceInformationQuestion(userText)) {
      return {
        say: 'I heard your question, but the response service is temporarily unavailable. I did not send it to the agent.',
        action: 'await',
        message: '',
        providerFailed: true,
      };
    }
    return providerFailureReply(userText, it?.project);
  } finally {
    clearTimeout(timer);
  }
}

route('POST', '/api/voice/start', async (req, res) => {
  gcVoiceSessions();
  const b = await readJson(req).catch(() => ({}));
  const focusSessionId = String(b.focusSessionId || '').slice(0, 80);
  const source = String(b.source || 'manual').slice(0, 40);
  const onTheGo = source.startsWith('on-the-go');
  const items = buildVoiceItems(focusSessionId, { onTheGo });
  if (!items.length) return json(res, 200, { voiceId: null, say: 'You have nothing waiting right now. All caught up.', done: true, listen: false });
  const vs = { id: id('v'), items, pointer: 0, history: [], onTheGo, createdAt: now(), lastTouch: now() };
  voiceSessions.set(vs.id, vs);
  prefetchBriefs(vs);
  const p = await presentNext(vs, true);
  if (p.ended) {
    voiceSessions.delete(vs.id);
    return json(res, 200, { voiceId: null, say: 'Everything that was waiting just got handled. All caught up.', done: true, listen: false });
  }
  json(res, 200, { voiceId: vs.id, say: p.say, done: false, listen: true, count: items.length, current: cur(vs) });
});

route('POST', '/api/voice/turn', async (req, res) => {
  gcVoiceSessions();
  const b = await readJson(req).catch(() => ({}));
  const vs = voiceSessions.get(b.voiceId);
  if (!vs) return json(res, 404, { error: 'no voice session' });
  // One turn at a time per voice session: the client never legitimately overlaps, so a second /turn
  // is a retry/duplicate — processing it would double-advance the pointer or double-send.
  if (vs.inflight) return json(res, 409, { error: 'turn already in flight' });
  vs.inflight = true;
  try {
    touch(vs);
    const rawUserText = String(b.userText || '').trim();
    if (!rawUserText) {
      if (vs.onTheGo) {
        // Silence is not a conversational turn. Keep it out of history and never synthesize a
        // response from it. After three quiet windows, end this pass silently; the persistent On the
        // go switch can announce the next new Needs You report without draining the microphone.
        vs.emptyTurns = (vs.emptyTurns || 0) + 1;
        const done = vs.emptyTurns >= 3;
        if (done) voiceSessions.delete(vs.id);
        return json(res, 200, {
          say: '',
          done,
          listen: !done,
          ignored: true,
          ignoredReason: 'no-speech',
          current: cur(vs),
        });
      }
      // Consecutive silent turns = capture is broken (mic denied, dead VAD, muted input) — a polite
      // re-ask forever is an infinite nag loop. Three strikes → end the pass gracefully.
      vs.emptyTurns = (vs.emptyTurns || 0) + 1;
      if (vs.emptyTurns >= 3) {
        voiceSessions.delete(vs.id);
        return json(res, 200, { say: "I'm having trouble hearing you, so I'll stop here. Check the microphone and tap voice again when you're ready.", done: true, listen: false });
      }
      return json(res, 200, { say: "Sorry, I didn't catch that — could you say it again?", done: false, listen: true });
    }
    vs.emptyTurns = 0;

    const userText = normalizeVoiceAddress(rawUserText);

    vs.history.push({ role: 'user', content: userText });
    // Confirmation is a state transition, not an open-ended reasoning task. Once the previous turn
    // established a pending instruction, "yes" (including "yes, and also ...") can be delivered
    // reliably even if every model provider is down on this turn.
    const r = confirmedPendingReply(vs.pendingInstruction, userText)
      || voiceControlReply(userText)
      || await brainReply(vs, userText);
    if (r.action === 'ignore') {
      vs.history.pop(); // nearby speech must not become context for the next real operator turn
      return json(res, 200, {
        say: '',
        done: false,
        listen: true,
        ignored: true,
        ignoredReason: 'not-addressed',
        current: cur(vs),
      });
    }
    vs.history.push({ role: 'assistant', content: r.say });
    trim(vs.history);
    const currentItem = vs.items[vs.pointer];
    const currentBeforeTurn = cur(vs);
    try {
      if (currentItem) store.addEvent(currentItem.sessionId, 'voice-turn', {
        action: r.action,
        mode: vs.onTheGo ? 'on-the-go' : 'manual',
        input_len: userText.length,
        has_message: !!r.message,
        // Keep a private recoverable draft at the delivery boundary. Successful sends are also
        // recorded as normal inbound messages; failed sends no longer erase the operator's words.
        ...(r.action === 'send' ? { draft: String(r.message || userText).slice(0, 8000) } : {}),
      });
    } catch {}

    if (r.action === 'send') {
      const it = vs.items[vs.pointer];
      vs.pendingInstruction = '';
      const outcome = await deliverVoiceFeedback({
        item: it,
        reply: { ...r, message: r.message || userText },
        // IncomingMessage.destroyed describes the HTTP request stream, not the voice conversation.
        // iPhone/PWA fetches commonly close that upload stream after the body is consumed, so using
        // req.destroyed here falsely cancelled valid feedback. /voice/stop removes the voice session;
        // that durable ownership is the only liveness signal relevant to delivery.
        requestAlive: voiceSessions.has(vs.id),
        getSession: (sid) => store.getSession(sid),
        answeredElsewhere: answeredElsewhereSince,
        deliverReply: (sid, message) => sessions.deliverReply(sid, message, { source: 'voice' }),
      });
      if (outcome.sent) {
        vs.sentCount = (vs.sentCount || 0) + 1;
        try { store.addEvent(it.sessionId, 'voice-reply', { len: outcome.delivery.length, mode: vs.onTheGo ? 'on-the-go' : 'manual' }); } catch {}
      }
      try { if (it) store.addEvent(it.sessionId, 'voice-delivery', outcome.delivery); } catch {}
      vs.pointer++;
      return json(res, 200, {
        say: outcome.say,
        done: false,
        listen: false,
        // The confirmation and receipt still describe the session we just delivered to. /continue
        // advances the UI to the next session after that confirmation finishes.
        current: currentBeforeTurn,
        delivery: outcome.delivery,
        sentCount: vs.sentCount || 0,
        ...(vs.onTheGo ? { acceptedText: userText } : {}),
      }); // client -> /continue presents next
    }
    if (r.action === 'next') {
      vs.pendingInstruction = '';
      vs.skipped = (vs.skipped || 0) + 1; // skipped items stay WAITING — they're still in the queue
      vs.pointer++;
      return json(res, 200, { say: r.say, done: false, listen: false, current: currentBeforeTurn, ...(vs.onTheGo ? { acceptedText: userText } : {}) });
    }
    if (r.action === 'stop') {
      vs.pendingInstruction = '';
      vs.done = true;
      voiceSessions.delete(vs.id);
      const count = vs.sentCount || 0;
      const say = vs.onTheGo
        ? count
          ? `Okay, stopping. I sent ${count} ${count === 1 ? 'feedback message' : 'feedback messages'} during this conversation.`
          : 'Okay, stopping. No feedback was sent during this conversation.'
        : r.say;
      return json(res, 200, { say, done: true, listen: false, sentCount: count, ...(vs.onTheGo ? { acceptedText: userText } : {}) });
    }
    // New-instruction replies carry the model's normalized draft. Older/less compliant models may
    // omit it, so retain the transcript when their spoken reply clearly asks for confirmation.
    if (r.message || asksForConfirmation(r.say)) vs.pendingInstruction = r.message || userText;
    return json(res, 200, { say: r.say, done: false, listen: true, current: cur(vs), ...(vs.onTheGo ? { acceptedText: userText } : {}) });
  } finally {
    vs.inflight = false;
  }
});

route('POST', '/api/voice/continue', async (req, res) => {
  gcVoiceSessions();
  const b = await readJson(req).catch(() => ({}));
  const vs = voiceSessions.get(b.voiceId);
  if (!vs) return json(res, 404, { error: 'no voice session' });
  if (vs.inflight) return json(res, 409, { error: 'turn already in flight' }); // a /continue racing a live /turn would double-advance
  touch(vs);
  const p = await presentNext(vs, false);
  if (p.ended) {
    voiceSessions.delete(vs.id);
    // Recount from the LIVE store — sent items are now 'working' (gone), but skipped items
    // are still 'waiting', so don't claim "all caught up" when the queue isn't actually empty.
    const remaining = buildVoiceItems().length;
    const say = remaining
      ? `That's the end of this pass. ${remaining} ${remaining > 1 ? 'items' : 'item'} still need you${vs.skipped ? ' — including the ones you skipped' : ''}. Tap voice again to go through them, or open the dashboard.`
      : "That's everything that needed you. You're all caught up — talk soon.";
    return json(res, 200, { say, done: true, listen: false, current: null });
  }
  json(res, 200, { say: p.say, done: false, listen: true, current: cur(vs) });
});

route('POST', '/api/voice/stop', async (req, res) => {
  gcVoiceSessions();
  const b = await readJson(req).catch(() => ({}));
  voiceSessions.delete(b.voiceId);
  json(res, 200, { ok: true });
});

// Spoken brief for one session (phone Listen buttons; desktop uses it through /api/voice).
route('POST', '/api/session/:id/brief', async (req, res, { id: sid }) => {
  const s2 = store.getSession(sid);
  if (!s2) return json(res, 404, { error: 'no such session' });
  const messages = store.messagesFor(sid, 200);
  const project = s2.project_id ? store.getProject(s2.project_id) : null;
  const evidence = await voiceEvidenceFor({
    sessionId: sid,
    projectId: s2.project_id || null,
    project: project?.name || 'adhoc',
    tool: s2.tool,
  });
  const brief = await buildVoiceBrief({
    sessionId: sid,
    project: project?.name || 'adhoc',
    projectIdentity: projectIdentityFor(project),
    tool: s2.tool, category: s2.category || 'review',
    ...evidence,
    originalRequest: originalRequestFrom(messages, s2.title || ''),
    latestReport: latestReportFor(s2),
    summary: s2.summary || s2.title || '', ask: s2.question || '',
    screen: '', supervisorNote: supervisorNoteFor(sid),
  });
  json(res, 200, { ok: true, brief });
});

console.log('[aios] voice concierge ready');
