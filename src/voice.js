import { route, json, readJson } from './server.js';
import * as store from './store.js';
import * as sessions from './sessions.js';
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
const VOICE_TTL_MS = 30 * 60 * 1000;
const TURN_BUDGET_MS = Number(process.env.AIOS_VOICE_TURN_BUDGET_MS || 12000); // must stay well inside the client's 30s /turn abort
const trim = (h) => { while (h.length > 16) h.shift(); };
const touch = (vs) => { vs.lastTouch = now(); };
// Lazy expiry keyed on LAST TOUCH, run on every voice endpoint — a createdAt-based sweep would kill
// a live long pass mid-conversation, and a timer-only sweep left abandoned sessions until the next /start.
function gcVoiceSessions() {
  for (const [k, v] of voiceSessions) if (now() - (v.lastTouch || v.createdAt) > VOICE_TTL_MS) voiceSessions.delete(k);
}
const cur = (vs) => {
  const it = vs.items[vs.pointer];
  return it ? { sessionId: it.sessionId, project: it.project, tool: it.tool, category: it.category, n: vs.pointer + 1, total: vs.items.length } : null;
};
// Did anyone else answer this session since we presented it? (dashboard reply, another device…)
// A voice reply dictated against an old prompt must not land on top of someone else's answer.
function answeredElsewhereSince(sessionId, sinceTs) {
  try {
    const r = store.db.prepare("SELECT COUNT(*) c FROM messages WHERE session_id = ? AND direction = 'in' AND ts > ? AND (source IS NULL OR source != 'voice')").get(sessionId, sinceTs || 0);
    return (r?.c || 0) > 0;
  } catch { return false; }
}

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
  return say;
}

// Advance to the next item that is STILL live and present it. Items resolve out from under a pass
// constantly (answered from the dashboard, another device, or the agent moved on) — presenting a
// snapshot blind risked sending a reply into a session that no longer asked anything. Re-checks once
// more AFTER the brief wait (status can flip during those 4s). Pushes the final spoken line into the
// brain history exactly once, only for what was actually said.
async function presentNext(vs, greet) {
  let skipped = 0;
  for (;;) {
    while (vs.pointer < vs.items.length && store.getSession(vs.items[vs.pointer].sessionId)?.status !== 'waiting') {
      vs.pointer++; skipped++;
    }
    if (vs.pointer >= vs.items.length) return { ended: true, skipped };
    const it = vs.items[vs.pointer];
    const say = await present(vs, greet);
    if (store.getSession(it.sessionId)?.status === 'waiting') {
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
  // gave up was still typed into the agent (double-send on the retry pass). Timeout → the safe
  // "say again" await; the aborted brain result can never reach a send.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TURN_BUDGET_MS);
  try {
    const ctx = await stateContext(vs, userText);
    const { obj } = await chatJson(
      [{ role: 'system', content: SYS + '\n\n' + ctx }, ...vs.history, { role: 'user', content: userText }],
      { temperature: 0.3, max_tokens: 650, timeout_ms: 10000, signal: ac.signal }
    );
    const action = ['await', 'send', 'next', 'stop'].includes(obj.action) ? obj.action : 'await';
    return { say: String(obj.say || '').trim() || 'Okay.', action, message: obj.message ? String(obj.message) : '' };
  } catch (e) {
    console.error('[aios] voice reply failed:', e.message);
    return { say: 'Sorry, I had trouble understanding. Could you say that again?', action: 'await', message: '' };
  } finally {
    clearTimeout(timer);
  }
}

route('POST', '/api/voice/start', async (req, res) => {
  gcVoiceSessions();
  const items = buildItems();
  if (!items.length) return json(res, 200, { voiceId: null, say: 'You have nothing waiting right now. All caught up.', done: true, listen: false });
  const vs = { id: id('v'), items, pointer: 0, history: [], createdAt: now(), lastTouch: now() };
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
    const userText = String(b.userText || '').trim();
    if (!userText) {
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

    vs.history.push({ role: 'user', content: userText });
    const r = await brainReply(vs, userText);
    vs.history.push({ role: 'assistant', content: r.say });
    trim(vs.history);

    if (r.action === 'send') {
      const it = vs.items[vs.pointer];
      let say = r.say;
      // The client may have died while we thought (abort/navigation) — a reply nobody heard
      // confirmed must not be delivered on top of a restarted pass.
      if (it && !req.destroyed && voiceSessions.has(vs.id)) {
        const live = store.getSession(it.sessionId);
        const msg = r.message || userText;
        if (!live || live.status === 'exited') {
          say = 'That session has stopped, so I could not send it. You can resume it from the dashboard. Moving on.';
        } else if (live.status !== 'waiting' && answeredElsewhereSince(it.sessionId, it.presentedAt)) {
          say = 'That item was already answered from somewhere else, so I did not send. Moving on.';
        } else {
          try {
            const dr = await sessions.deliverReply(it.sessionId, msg, { source: 'voice' });
            if (dr.stopped || dr.missing) {
              say = 'That session has stopped, so I could not send it. You can resume it from the dashboard. Moving on.';
            } else {
              try { store.addEvent(it.sessionId, 'voice-reply', { len: msg.length }); } catch {}
            }
          } catch (e) {
            console.error('[aios] voice send failed:', e.message);
            say = "I couldn't deliver that reply — the send failed, so it still needs you. Moving on for now.";
          }
        }
      }
      vs.pointer++;
      return json(res, 200, { say, done: false, listen: false, current: cur(vs) }); // client -> /continue presents next
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
    const remaining = buildItems().length;
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
