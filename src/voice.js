import { route, json, readJson } from './server.js';
import * as store from './store.js';
import * as sessions from './sessions.js';
import { bus } from './bus.js';
import { chatJson } from './llm.js';
import { id, now, stripAnsi } from './util.js';
import { buildVoiceBrief, speakBrief, sanitizeForSpeech } from './voice_brief.js';
import { searchWiki } from './wiki.js';

// Hands-free voice concierge: walk the needs-you queue oldest-first, converse about
// each item, confirm, and send the user's instruction to the CLI agent. The brain is
// the llm.js fallback chain. The browser handles TTS playback + STT (with VAD).

const SYS = `You are Supercalm Voice, a hands-free voice concierge. You help the user clear a queue of CLI coding-agent sessions waiting on them; you SPEAK (text-to-speech) and they reply by voice. Be warm and VERY brief: at most 2 short spoken sentences, ~25 words total — this is read aloud by a neural voice, so every extra word adds delay before you start speaking. No markdown, no code, no URLs, no emoji; keep key technical terms but phrase for the ear.
For the user's reply about the CURRENT item:
- an instruction for the agent -> restate its core in one sentence and ask them to confirm (action "await").
- a confirmation (yes/go/send/correct) -> action "send", with "message" = a clear actionable instruction that captures their intent.
- asks for detail or your opinion -> answer briefly, stay here (action "await").
- asks a QUESTION about the session, the project, or what the supervisor thinks -> answer from CONTEXT (recent messages, screen, PROJECT KNOWLEDGE, SUPERVISOR notes) in 1-2 spoken sentences, then action "await". If the context doesn't contain the answer, say so plainly — never invent. Never speak URLs or file paths; use bare file names.
- skip / pass / later / next -> action "next".
- stop / done / that's all -> action "stop".
Default to "await" for any NEW instruction — confirm before acting. Only use "send" once the user confirms (yes / go / correct / send it) OR gives an explicit do-it directive (e.g. "just do it", "go ahead and send"). When unsure between await and send, choose await.
On "send" or "next", briefly confirm and say you're moving on — do NOT describe or invent the next item; the system presents it on the next turn.
When asked to PRESENT an item: say what its agent needs and ask what they want to do; mention the count only at the very start. Ignore any greyed composer placeholder hint (e.g. "Explain this codebase") — it is not a real task.
Reply with STRICT minified JSON ONLY, no fences: {"say":"...","action":"await|send|next|stop","message":"...only when action=send..."}`;

const voiceSessions = new Map();
const trim = (h) => { while (h.length > 16) h.shift(); };
const cur = (vs) => {
  const it = vs.items[vs.pointer];
  return it ? { sessionId: it.sessionId, project: it.project, tool: it.tool, category: it.category, n: vs.pointer + 1, total: vs.items.length } : null;
};

function buildItems() {
  const live = store
    .listLiveSessions()
    .filter((s) => s.status === 'waiting' && s.category !== 'working')
    .sort((a, b) => (a.last_activity || 0) - (b.last_activity || 0)); // oldest waiting first
  return live.map((s) => ({
    sessionId: s.id,
    tmux: s.tmux,
    tool: s.tool,
    project: s.project_id ? store.getProject(s.project_id)?.name || 'adhoc' : 'adhoc',
    summary: s.summary || s.title || '',
    category: s.category || 'review',
  }));
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

async function stateContext(vs, userText = '') {
  const it = vs.items[vs.pointer];
  const lines = [`You are on item ${vs.pointer + 1} of ${vs.items.length}.`];
  if (it) {
    lines.push(`CURRENT: ${it.project} (${it.tool}), ${it.category}. ${it.summary}`);
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
    let screen = '';
    try { screen = await sessions.snapshot(it.sessionId); } catch {}
    const s2 = store.getSession(it.sessionId);
    it._brief = await buildVoiceBrief({
      sessionId: it.sessionId, project: it.project, tool: it.tool, category: it.category,
      summary: it.summary, ask: s2?.question || '', screen, supervisorNote: supervisorNoteFor(it.sessionId),
    });
  } catch { it._brief = null; }
  return it._brief;
}
function prefetchBriefs(vs) {
  for (const it of vs.items.slice(0, 12)) briefFor(it).catch(() => {}); // fire-and-forget: item 2+ speak instantly
}

async function present(vs, greet) {
  const it = vs.items[vs.pointer];
  let say;
  if (!it) {
    say = greet ? 'You have nothing waiting right now. All caught up.' : 'What next?';
  } else {
    const n = vs.items.length;
    const where = it.project && it.project !== 'adhoc' ? `${it.project} ${it.tool}` : it.tool;
    const lead = greet ? `You have ${n} ${n > 1 ? 'items' : 'item'} waiting. First up, ${where}.` : `Next, ${where}.`;
    // spoken brief (gpt-5.5) with a hard latency budget; sanitized template if it isn't ready
    const brief = await Promise.race([briefFor(it), new Promise((r) => setTimeout(() => r(null), 4000))]);
    if (brief) {
      say = `${lead} ${speakBrief(brief, { level: 'standard' })} ${brief.needs ? '' : 'What would you like to do?'}`.trim();
      if (brief.needs && !brief.options?.length) say += ` ${brief.needs}`;
    } else {
      const cat = ['action', 'decision', 'review'].includes(it.category) ? it.category : 'response';
      let gist = sanitizeForSpeech(String(it.summary || '')).replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
      if (gist.length > 120) gist = gist.slice(0, 120).replace(/\s+\S*$/, '') + '…';
      say = `${lead} A ${cat}. ${gist ? gist + '.' : ''} What would you like to do?`;
    }
  }
  vs.history.push({ role: 'assistant', content: say });
  trim(vs.history);
  return say;
}

async function brainReply(vs, userText) {
  try {
    const ctx = await stateContext(vs, userText);
    const { obj } = await chatJson([{ role: 'system', content: SYS + '\n\n' + ctx }, ...vs.history, { role: 'user', content: userText }], { temperature: 0.3, max_tokens: 650 });
    const action = ['await', 'send', 'next', 'stop'].includes(obj.action) ? obj.action : 'await';
    return { say: String(obj.say || '').trim() || 'Okay.', action, message: obj.message ? String(obj.message) : '' };
  } catch (e) {
    console.error('[aios] voice reply failed:', e.message);
    return { say: 'Sorry, I had trouble understanding. Could you say that again?', action: 'await', message: '' };
  }
}

route('POST', '/api/voice/start', async (req, res) => {
  // drop stale sessions
  for (const [k, v] of voiceSessions) if (now() - v.createdAt > 30 * 60 * 1000) voiceSessions.delete(k);
  const items = buildItems();
  const vs = { id: id('v'), items, pointer: 0, history: [], createdAt: now() };
  voiceSessions.set(vs.id, vs);
  prefetchBriefs(vs);
  if (!items.length) return json(res, 200, { voiceId: vs.id, say: 'You have nothing waiting right now. All caught up.', done: true, listen: false });
  const say = await present(vs, true);
  json(res, 200, { voiceId: vs.id, say, done: false, listen: true, count: items.length, current: cur(vs) });
});

route('POST', '/api/voice/turn', async (req, res) => {
  const b = await readJson(req).catch(() => ({}));
  const vs = voiceSessions.get(b.voiceId);
  if (!vs) return json(res, 404, { error: 'no voice session' });
  const userText = String(b.userText || '').trim();
  if (!userText) return json(res, 200, { say: "Sorry, I didn't catch that — could you say it again?", done: false, listen: true });

  vs.history.push({ role: 'user', content: userText });
  const r = await brainReply(vs, userText);
  vs.history.push({ role: 'assistant', content: r.say });
  trim(vs.history);

  if (r.action === 'send') {
    const it = vs.items[vs.pointer];
    if (it) {
      try {
        await sessions.sendText(it.tmux, r.message || userText);
        store.addMessage(it.sessionId, 'in', 'voice', r.message || userText);
        store.answerPendingDecision(it.sessionId, { response: r.message || userText, response_source: 'voice' }); // link to the open ask
        sessions.noteReply(it.sessionId); // -> working: drop it off the needs-you queue NOW, like a text reply
        store.addEvent(it.sessionId, 'voice-reply', { len: (r.message || userText).length });
        bus.emit('event', { type: 'input', session: it.sessionId, source: 'voice' }); // doctrine distiller listens
      } catch (e) {
        console.error('[aios] voice send failed:', e.message);
      }
    }
    vs.pointer++;
    return json(res, 200, { say: r.say, done: false, listen: false, current: cur(vs) }); // client -> /continue presents next
  }
  if (r.action === 'next') {
    vs.skipped = (vs.skipped || 0) + 1; // skipped items stay WAITING — they're still in the queue
    vs.pointer++;
    return json(res, 200, { say: r.say, done: false, listen: false, current: cur(vs) });
  }
  if (r.action === 'stop') {
    vs.done = true;
    voiceSessions.delete(vs.id);
    return json(res, 200, { say: r.say, done: true, listen: false });
  }
  return json(res, 200, { say: r.say, done: false, listen: true, current: cur(vs) });
});

route('POST', '/api/voice/continue', async (req, res) => {
  const b = await readJson(req).catch(() => ({}));
  const vs = voiceSessions.get(b.voiceId);
  if (!vs) return json(res, 404, { error: 'no voice session' });
  if (vs.pointer >= vs.items.length) {
    voiceSessions.delete(vs.id);
    // Recount from the LIVE store — sent items are now 'working' (gone), but skipped items
    // are still 'waiting', so don't claim "all caught up" when the queue isn't actually empty.
    const remaining = buildItems().length;
    const say = remaining
      ? `That's the end of this pass. ${remaining} ${remaining > 1 ? 'items' : 'item'} still need you${vs.skipped ? ' — including the ones you skipped' : ''}. Tap voice again to go through them, or open the dashboard.`
      : "That's everything that needed you. You're all caught up — talk soon.";
    return json(res, 200, { say, done: true, listen: false, current: null });
  }
  const say = await present(vs, false);
  json(res, 200, { say, done: false, listen: true, current: cur(vs) });
});

route('POST', '/api/voice/stop', async (req, res) => {
  const b = await readJson(req).catch(() => ({}));
  voiceSessions.delete(b.voiceId);
  json(res, 200, { ok: true });
});

// Spoken brief for one session (phone Listen buttons; desktop uses it through /api/voice).
route('POST', '/api/session/:id/brief', async (req, res, { id: sid }) => {
  const s2 = store.getSession(sid);
  if (!s2) return json(res, 404, { error: 'no such session' });
  let screen = '';
  try { screen = await sessions.snapshot(sid); } catch {}
  const brief = await buildVoiceBrief({
    sessionId: sid,
    project: s2.project_id ? store.getProject(s2.project_id)?.name || 'adhoc' : 'adhoc',
    tool: s2.tool, category: s2.category || 'review',
    summary: s2.summary || s2.title || '', ask: s2.question || '',
    screen, supervisorNote: supervisorNoteFor(sid),
  });
  json(res, 200, { ok: true, brief });
});

console.log('[aios] voice concierge ready');
