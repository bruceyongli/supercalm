// Supercalm — phone companion view (design_handoff_supercalm_phone).
// One loop: triage what needs you → read/listen to the KEY message only → answer by voice or a tap.
// Everything else (terminal, panels, stop/kill) is one tap away, never in the way.
//
// Focus rule (the #1 bug this design fixes): the composer is a FAKE pill; a real input mounts and
// focuses only on an explicit tap. Nothing ever focuses on scroll, open, or nav.
//
// Data: GET api/phone/home (one lean fetch: sessions + unread counts + last key message),
// GET api/session/:id (turns from the messages table: in = user, out = agent key messages),
// POST api/messages/read (read-state syncs server-side so desktop and phone agree),
// existing input/type/stop/kill/resume + /api/tts + /api/transcribe. Live via /api/events SSE.

import { api, coalesce, createLiveSpeechRecognizer, escapeHtml as esc, registerSW, renderMarkdown } from './common.js';
import { initAgentPanel } from './agents/host.js';
import { unlockAudio, newPlayback, splitSentences, stopAllPlayback, speakSmart } from './tts-player.js'; // the ONE shared TTS stack
import { isVoiceModeActive, startVoiceMode, stopVoiceMode } from './voicemode.js';
import { answersPayload, attentionReportKey, ensureOptionQuestions, getOptionQuestions } from './attention-options.js';
import { attentionCopy } from './attention-preview.js';
import { observeOnTheGoNeeds, onTheGoState, setOnTheGoVoiceAdapter, setVoiceUpdateStyle, subscribeOnTheGo, toggleOnTheGo } from './on-the-go.js';
import { extractVoiceInterruption, isClearVoiceInterruption } from './voice-interruption.js';
import { VOICE_CAPTURE_DEFAULTS, voiceTranscriptDisposition } from './voice-input.js';

registerSW();

const app = document.getElementById('app');
const choiceSelections = new Map();
const submittingChoices = new Set();

// ---- state -------------------------------------------------------------------------------------
const S = {
  screen: 'home', sid: null,
  home: null, // /api/phone/home payload
  detail: null, // /api/session/:id payload for the open session
  overlay: null, // 'report' | 'raw' | null
  reportMsg: null, rawText: '',
  sheet: null, // 'panels' | 'actions' | 'rec' | 'review' | null
  typing: false, text: '', keysOpen: localStorage.ph_keys !== '0',
  speakingId: null, playScope: null, // 'home' | 'sess' | 'report' | 'one'
  queue: [],
  rec: { t0: 0, timer: null, media: null, chunks: [] }, draft: '',
  killArmed: false, killTimer: null,
  toast: '', toastTimer: null,
  dismissedOpen: false,
  appVersion: null,
};
addEventListener('aios:version', (event) => {
  const version = event.detail?.version;
  if (!version || version === S.appVersion) return;
  S.appVersion = version;
  if (S.screen === 'home') renderSoft();
});

// ---- utils -------------------------------------------------------------------------------------
const $ = (sel) => app.querySelector(sel);
function ago(ts) {
  const m = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  if (m < 60 * 36) return Math.round(m / 60) + 'h';
  return Math.round(m / 1440) + 'd';
}
const BADGE = { action: ['ACTION', '#f2554d'], decision: ['DECISION', '#e2b23e'], review: ['REVIEW', '#3fbf5f'] };
function badgeFor(s) { return BADGE[s.category] || null; }
const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity' };
function chipColor(tool) { return tool === 'claude' ? 'var(--chip-claude)' : 'var(--chip-codex)'; }
function statusColor(st) { return st === 'working' ? 'var(--green-dot)' : st === 'exited' ? 'var(--tx-faint)' : st === 'starting' ? 'var(--blue)' : st === 'error' ? 'var(--red)' : 'var(--yellow)'; }
function statusWord(st) { return st === 'working' ? 'Working' : st === 'exited' ? 'Stopped' : st === 'starting' ? 'Starting' : st === 'error' ? 'Failed' : 'Waiting'; }
function toast(t) {
  S.toast = t;
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => { S.toast = ''; render(); }, 2300);
  render();
}
function hhmm(ts) { const d = new Date(Number(ts)); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function attentionPreview(session, { optionCount = 0 } = {}) {
  const copy = attentionCopy({
    request: session.title,
    question: session.question,
    summary: session.summary,
    fallback: session.last_key?.text,
    category: session.category,
    optionCount,
  });
  return {
    request: copy.request || session.title || session.id,
    need: copy.action,
    outcome: copy.happened || copy.latest,
    actionSource: copy.actionSource,
  };
}
function phoneNeeds() {
  return (S.home?.sessions || []).filter((session) =>
    !session.dismissed
    && session.unread > 0
    && session.status === 'waiting'
    && session.category
    && session.category !== 'working');
}

// unread = agent messages newer than the operator's last reply, not yet marked read (server truth)
function unreadOf(detail) {
  if (!detail?.messages) return [];
  const lastIn = Math.max(0, ...detail.messages.filter((m) => m.direction === 'in').map((m) => m.ts));
  const un = detail.messages.filter((m) => m.direction === 'out' && !m.read_at && m.ts > lastIn);
  return un.slice(-1); // the LATEST report is the key message; older ones are stale frames of the same episode
}
// Detect-out messages are raw terminal tail snippets: strip spinner/footer junk for reading.
function cleanTail(text) {
  return String(text || '')
    .split('\n')
    .filter((l) => !/^\s*[✻✽·∗]\s|^\s*\d+ background terminal|\/ps to view|\/stop to close|^● How is Claude doing|^1: Bad\s|^\s*esc to interrupt/i.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function fallbackOptionQuestions(session) {
  const text = String(session.question || session.summary || '');
  const options = [...text.matchAll(/(?:^|\n)\s*(\d)[.)]\s*([^\n]{3,80})/g)].map((match) => ({ key: match[1], label: match[2].trim(), description: '' }));
  if (!options.length && /\by\/n\b|\byes\/no\b/i.test(text)) options.push({ key: 'y', label: 'yes', description: '' }, { key: 'n', label: 'no', description: '' });
  return options.length ? [{ id: `fallback:${session.id}`, header: '', question: text, multiSelect: false, options: options.slice(0, 6) }] : [];
}
function phoneOptionQuestions(session) {
  const structured = getOptionQuestions(session);
  return structured.length ? structured : fallbackOptionQuestions(session);
}
function phoneSelections(session) {
  const reportKey = attentionReportKey(session);
  let state = choiceSelections.get(session.id);
  if (!state || state.reportKey !== reportKey) {
    state = { reportKey, questions: new Map() };
    choiceSelections.set(session.id, state);
  }
  return state.questions;
}
function phoneChoicesComplete(questions, selections) {
  return questions.length > 0 && questions.every((_, index) => (selections.get(index)?.size || 0) > 0);
}
// report treatment: structure (headings/code/table/lists) always, or long plain text
function isReport(text) {
  const t = String(text || '');
  const structural = /(^|\n)#{1,4}\s|```|(^|\n)\|.+\|/.test(t) || (t.match(/(^|\n)\s*[-*•]\s+/g) || []).length > 3;
  return structural || t.length > 400;
}
function headlineOf(text) {
  const t = String(text || '').trim();
  const firstLine = (t.split('\n').find((l) => l.trim()) || '').replace(/^#+\s*/, '').trim();
  return firstLine.slice(0, 160) || 'Agent report';
}
function digestOf(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim());
  const bullets = lines.filter((l) => /^[-*•]\s+/.test(l)).map((l) => l.replace(/^[-*•]\s+/, '')).slice(0, 3);
  if (bullets.length) return bullets;
  const paras = String(text || '').split(/\n{2,}/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p && !/^#/.test(p));
  return paras.slice(1, 3).map((p) => p.slice(0, 140));
}

// ---- data --------------------------------------------------------------------------------------
async function loadHome() {
  let ok = false;
  try {
    const next = await api('api/phone/home');
    if (S.home?.sessions?.length && next?.sessions?.length) {
      const previous = S.home.sessions;
      const known = new Set(previous.map((session) => session.id));
      const incoming = new Map(next.sessions.map((session) => [session.id, session]));
      const newcomers = next.sessions.filter((session) => !known.has(session.id));
      const retained = previous.map((session) => incoming.get(session.id)).filter(Boolean);
      const placed = new Set([...newcomers, ...retained].map((session) => session.id));
      next.sessions = [...newcomers, ...retained, ...next.sessions.filter((session) => !placed.has(session.id))];
    }
    S.home = next;
    observeOnTheGoNeeds(phoneNeeds());
    ok = true;
  } catch { /* keep stale */ }
  if (S.screen === 'home') renderSoft();
  return ok;
}
async function loadDetail(sid) {
  try {
    const d = await api('api/session/' + sid);
    // identical message set -> keep the existing DOM entirely (no scroll/pulse churn)
    const sig = (x) => (x?.messages || []).map((m) => m.id + ':' + (m.read_at ? 1 : 0)).join(',') + '|' + x?.status + '|' + (x?.question || '').length;
    const changed = sig(d) !== sig(S.detail);
    S.detail = d;
    if (S.screen === 'session' && S.sid === sid && changed) renderSoft();
  } catch { /* keep stale */ }
}
const refresh = coalesce(async () => { await loadHome(); if (S.screen === 'session' && S.sid) await loadDetail(S.sid); }, 3000);
function patchSession(payload) {
  if (!payload?.session || !S.home?.sessions) return;
  const i = S.home.sessions.findIndex((s) => s.id === payload.session);
  const patch = {};
  for (const [k, v] of Object.entries(payload)) if (v !== undefined && k !== 'session') patch[k] = v;
  if (Object.hasOwn(patch, 'project')) patch.project = typeof patch.project === 'object' ? patch.project?.name || '' : patch.project;
  if (i >= 0) S.home.sessions[i] = { ...S.home.sessions[i], ...patch };
  else if (patch.status) S.home.sessions.unshift({ id: payload.session, ...patch });
  else return; // unread-only patches cannot construct an unknown session row
  const sessions = S.home.sessions;
  S.home.counts = {
    waiting: sessions.filter((s) => s.status === 'waiting').length,
    working: sessions.filter((s) => s.status === 'working').length,
    live: sessions.filter((s) => ['starting', 'working', 'waiting'].includes(s.status)).length,
    dismissed: sessions.filter((s) => s.dismissed).length,
  };
  observeOnTheGoNeeds(phoneNeeds());
  if (S.detail?.id === payload.session) S.detail = { ...S.detail, ...patch };
  if (S.screen === 'home' || S.sid === payload.session) renderSoft();
}
try {
  const es = new EventSource('api/events');
  es.addEventListener('session-status', (e) => {
    let payload;
    try { payload = JSON.parse(e.data || '{}'); } catch { return; }
    patchSession(payload);
    if (S.sid === payload.session && (payload.previousStatus !== payload.status || payload.source === 'summary')) loadDetail(S.sid);
  });
} catch {}
setInterval(refresh, 120000); // recovery only; ordinary status changes are compact row patches

async function markRead(ids, sid = null) {
  if (!ids.length && !sid) return;
  try { await api('api/messages/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sid ? { session_id: sid } : { ids }) }); } catch {}
  if (sid) { const s = (S.home?.sessions || []).find((x) => x.id === sid); if (s) s.unread = 0; }
  // optimistic local mirror
  const t = Date.now();
  for (const m of S.detail?.messages || []) if (ids.includes(m.id)) m.read_at = t;
  for (const s of S.home?.sessions || []) if (s.last_key && ids.includes(s.last_key.id)) s.unread = Math.max(0, s.unread - 1);
  render();
}

// ---- spoken briefs (shared Voice Assistant briefing route) -----------------------------------------
const briefCache = new Map();
async function fetchBrief(sid) {
  if (briefCache.has(sid)) return briefCache.get(sid);
  try {
    const r = await Promise.race([
      api(`api/session/${sid}/brief`, { method: 'POST' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('brief timeout')), 6000)),
    ]);
    if (r?.brief) { briefCache.set(sid, r.brief); setTimeout(() => briefCache.delete(sid), 90000); return r.brief; }
  } catch {}
  return null;
}
function spokenFromBrief(b, fallback) {
  if (!b) return fallback;
  const opts = b.options?.length ? ' Options: ' + b.options.map((o) => `${o.key}, ${o.spoken || o.label}`).join('. ') + '.' : '';
  return `${b.topic}. ${b.standard}${opts}`.trim();
}

// ---- TTS — the ONE shared stack (tts-player.js): stream → single → device voice --------------------
let phoneHandle = null; // current tts-player playback handle
function stopSpeech() {
  S.queue = [];
  S.speakingId = null;
  S.playScope = null;
  try { phoneHandle?.stop(); } catch {}
  try { stopAllPlayback(); } catch {}
  render();
}
async function speakOne(text, options = {}) {
  phoneHandle = newPlayback();
  try { await speakSmart(text, phoneHandle, options); } catch {}
  return !phoneHandle.stopped; // done (true) unless it was stopped mid-line
}
async function playQueue(items, scope) {
  unlockAudio(); // gesture-unlock the shared player (this runs inside the tap that started the queue)
  stopSpeech();
  S.queue = items.slice();
  S.playScope = scope;
  render();
  while (S.queue.length && S.playScope === scope) {
    const it = S.queue.shift();
    S.speakingId = it.mid || null;
    render();
    let text = it.text;
    if (it.briefSid) text = spokenFromBrief(await fetchBrief(it.briefSid), it.text);
    if (S.playScope !== scope) return;
    const done = await speakOne(text);
    if (S.playScope !== scope) return; // stopped mid-queue: do NOT mark read (design)
    if (done && it.mid != null) await markRead([it.mid], it.sid || null);
  }
  S.speakingId = null;
  S.playScope = null;
  render();
}

// ---- Voice Assistant (home): the shared concierge, hands-free on the phone -------------------------
// start → server presents item (TTS) → we auto-listen (VAD: speech start on energy, end on ~1.4s of
// silence) → polished STT → shared intent reasoning → questions stay with the assistant; instructions
// are restated and confirmed before they reach the agent. One tap in, zero after.
const V = { on: false, voiceId: null, state: 'idle', current: null, lastHeard: '', ignoredReason: '', silentTurns: 0, stream: null, ac: null, stopFlag: false, onTheGo: false, said: '', segment: '', delivery: null, sentCount: 0, responseGrounded: false };
let phoneInterrupt = null;
function setVoiceCurrent(next) {
  const previousId = V.current?.sessionId || '';
  const nextId = next?.sessionId || '';
  V.current = next || null;
  // A reply and its delivery receipt belong only to the session that received them. Keep both visible
  // through that session's confirmation, then clear them as the next session is presented.
  if (previousId && nextId && previousId !== nextId) {
    V.lastHeard = '';
    V.ignoredReason = '';
    V.delivery = null;
    V.segment = '';
    V.responseGrounded = false;
  }
}
function paintVoiceSegment(text) {
  const line = app.querySelector('.ongo-sheet-report p');
  if (line && text) line.textContent = text;
}
function paintVoiceHeard(text) {
  const line = app.querySelector('.ongo-sheet-heard span');
  if (line && text) line.textContent = `“${text.slice(0, 260)}”`;
}
function phoneVoiceThreadLabel(cur) {
  const parts = [];
  for (const value of [cur?.topic, cur?.module, cur?.workstream]) {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (parts.some((part) => part.toLowerCase() === key || part.toLowerCase().includes(key) || key.includes(part.toLowerCase()))) continue;
    parts.push(clean);
  }
  return parts.slice(0, 2).join(' · ');
}
let onTheGoUi = onTheGoState();
// Phone used to override the shared adapter with the legacy implementation below. That second loop
// created its VAD AudioContext after the initiating tap, so iOS left it suspended and loud replies
// repeatedly became "no response". Keep phone/PWA/desktop on the one gesture-unlocked Voice client.
setOnTheGoVoiceAdapter({
  active: isVoiceModeActive,
  start: (options = {}) => { stopSpeech(); return startVoiceMode(options); },
  stop: stopVoiceMode,
});
subscribeOnTheGo((state) => {
  onTheGoUi = state;
  if (S.home && S.screen === 'home') renderSoft();
});
window.addEventListener('aios:voice-mode-end', () => {
  if (S.screen === 'home') renderSoft();
});

async function voiceModeStart(focusSessionId = null, { onTheGo = false } = {}) {
  if (V.on) return;
  unlockAudio(); // gesture-unlock the shared player before any await
  stopSpeech();
  try { V.stream = await navigator.mediaDevices.getUserMedia(phoneVoiceConstraints()); } catch (e) { toast('Mic unavailable: ' + (e.message || e)); return; }
  V.on = true; V.state = 'starting'; V.stopFlag = false; V.onTheGo = onTheGo; V.said = ''; V.segment = ''; V.lastHeard = ''; V.ignoredReason = ''; V.silentTurns = 0; V.delivery = null; V.sentCount = 0; V.responseGrounded = false; S.sheet = 'voicemode';
  render();
  try {
    const r = await api('api/voice/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ focusSessionId, source: onTheGo ? 'on-the-go-update' : 'manual' }),
    });
    V.voiceId = r.voiceId; setVoiceCurrent(r.current || null);
    const interruption = await voiceSay(r.say, { allowInterruption: !r.done });
    if (r.done) return voiceModeEnd('done');
    if (interruption?.text) return voiceSubmitTurn(interruption.text);
    if (r.listen || interruption?.tap) return voiceLoopListen();
  } catch (e) { toast('Voice mode failed: ' + (e.message || e)); voiceModeEnd('error'); }
}
function phoneVoiceConstraints() {
  const supported = navigator.mediaDevices?.getSupportedConstraints?.() || {};
  const audio = {};
  if (supported.echoCancellation) audio.echoCancellation = true;
  if (supported.noiseSuppression) audio.noiseSuppression = true;
  if (supported.autoGainControl) audio.autoGainControl = true;
  if (supported.channelCount) audio.channelCount = { ideal: 1 };
  return Object.keys(audio).length ? { audio } : { audio: true };
}
async function voiceSay(text, { allowInterruption = false } = {}) {
  if (!text || V.stopFlag) return;
  V.state = 'speaking'; V.said = text;
  V.segment = splitSentences(text)[0] || String(text);
  render();
  let live = null;
  let accepted = null;
  let capturingSpeech = false;
  let pendingSpeech = '';
  let speechTimer = null;
  let resolveInterruption;
  const interruption = new Promise((resolve) => { resolveInterruption = resolve; });
  const haltPlayback = () => {
    try { phoneHandle?.stop(); } catch {}
    try { stopAllPlayback(); } catch {}
  };
  const accept = (result) => {
    if (accepted || V.stopFlag) return;
    accepted = result;
    if (speechTimer) clearTimeout(speechTimer);
    resolveInterruption(result);
    haltPlayback();
  };
  if (allowInterruption) {
    phoneInterrupt = accept;
    live = createLiveSpeechRecognizer({
      onUpdate: (heard) => {
        if (accepted || (!capturingSpeech && !isClearVoiceInterruption(heard, text))) return;
        if (!capturingSpeech) {
          capturingSpeech = true;
          haltPlayback(); // stop now, then retain subsequent interim words before sending the turn
          V.state = 'listening';
          render();
        }
        pendingSpeech = extractVoiceInterruption(heard, text) || heard.trim();
        V.lastHeard = pendingSpeech;
        paintVoiceHeard(pendingSpeech);
        if (speechTimer) clearTimeout(speechTimer);
        speechTimer = setTimeout(() => accept({ text: pendingSpeech }), 700);
      },
    });
    live.start();
  }
  const playback = speakOne(text, {
    onSegment: ({ text: segment }) => {
      if (!segment || V.stopFlag) return;
      V.segment = segment;
      // Only the sentence being read changes here. Rebuilding the whole sheet on every boundary made
      // the iPhone view visibly flash and reset scroll/touch state.
      paintVoiceSegment(segment);
    },
  }).then(() => null, () => null);
  const playbackOrCapture = playback.then(() => capturingSpeech ? interruption : null);
  const result = allowInterruption ? await Promise.race([playbackOrCapture, interruption]) : await playback;
  if (phoneInterrupt === accept) phoneInterrupt = null;
  if (speechTimer) clearTimeout(speechTimer);
  live?.abort();
  if (accepted) await Promise.race([playback, new Promise((resolve) => setTimeout(resolve, 250))]);
  return accepted || result;
}
async function voiceLoopListen() {
  if (V.stopFlag) return;
  V.state = 'listening'; render();
  const blob = await vadRecord(V.stream, { maxMs: 45000 });
  if (V.stopFlag) return;
  if (!blob || blob.size < 800) {
    return voiceMissedInput('no-speech');
  }
  V.state = 'thinking'; render();
  let text = '';
  try {
    const r = await fetch('api/transcribe?polish=true', { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob });
    const j = await r.json();
    text = (j.text || '').trim();
  } catch {}
  if (V.stopFlag) return;
  if (!text) {
    return voiceMissedInput('no-speech');
  }
  return voiceSubmitTurn(text);
}
async function voiceSubmitTurn(text) {
  if (V.stopFlag || !text) return;
  const disposition = voiceTranscriptDisposition(text, { spoken: V.said });
  if (!disposition.accepted) {
    return voiceMissedInput(disposition.reason);
  }
  text = disposition.text;
  V.silentTurns = 0; V.lastHeard = text; V.ignoredReason = ''; render();
  try {
    const r = await api('api/voice/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voiceId: V.voiceId, userText: text }) });
    setVoiceCurrent(r.current || V.current);
    if (r.acceptedText) V.lastHeard = r.acceptedText;
    V.ignoredReason = r.ignored ? (r.ignoredReason || 'not-addressed') : '';
    V.delivery = r.delivery || V.delivery;
    V.sentCount = Number(r.sentCount ?? V.sentCount) || 0;
    V.responseGrounded = !!r.grounded;
    const interruption = await voiceSay(r.say, { allowInterruption: !r.done });
    render();
    if (V.stopFlag) return;
    if (r.done) return voiceModeEnd('done');
    if (interruption?.text) return voiceSubmitTurn(interruption.text);
    if (r.listen || interruption?.tap) return voiceLoopListen();
    // sent/skipped -> ask the server to present the next item
    const c = await api('api/voice/continue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voiceId: V.voiceId }) });
    setVoiceCurrent(c.current || null);
    const nextInterruption = await voiceSay(c.say, { allowInterruption: !c.done });
    if (V.stopFlag) return;
    if (c.done) return voiceModeEnd('done');
    if (nextInterruption?.text) return voiceSubmitTurn(nextInterruption.text);
    return voiceLoopListen();
  } catch (e) { toast('Voice turn failed: ' + (e.message || e)); return voiceModeEnd('error'); }
}
async function voiceMissedInput(reason) {
  if (V.stopFlag) return;
  V.ignoredReason = reason;
  V.lastHeard = '';
  V.silentTurns++;
  render();
  if (V.voiceId) {
    await api('api/voice/keepalive', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voiceId: V.voiceId, reason }),
    }).catch(() => {});
  }
  // A broken recorder can resolve immediately; keep the assistant alive without creating a hot loop.
  await new Promise((resolve) => setTimeout(resolve, 250));
  return voiceLoopListen();
}
function voiceModeEnd(why) {
  const sentCount = V.sentCount;
  V.stopFlag = true; V.on = false; V.state = 'idle'; V.onTheGo = false; V.said = ''; V.segment = '';
  phoneInterrupt = null;
  try { V.stream?.getTracks().forEach((t) => t.stop()); } catch {}
  V.stream = null;
  if (V.voiceId) api('api/voice/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voiceId: V.voiceId }) }).catch(() => {});
  V.voiceId = null;
  stopSpeech();
  if (S.sheet === 'voicemode') S.sheet = null;
  if (why === 'done') loadHome();
  if (sentCount) toast(`${sentCount} ${sentCount === 1 ? 'feedback message' : 'feedback messages'} sent`);
  render();
}
// energy-gated recorder: resolves with the utterance blob once the speaker pauses
function vadRecord(stream, {
  maxMs = 45000,
  silenceMs = VOICE_CAPTURE_DEFAULTS.silenceMs,
  minSpeechMs = VOICE_CAPTURE_DEFAULTS.minSpeechMs,
  threshold = VOICE_CAPTURE_DEFAULTS.threshold,
  graceMs = VOICE_CAPTURE_DEFAULTS.graceMs,
} = {}) {
  return new Promise((resolve) => {
    let rec;
    try {
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch { return resolve(null); }
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    if (!V.ac) { try { V.ac = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
    const ac = V.ac;
    let src, an, buf;
    try {
      src = ac.createMediaStreamSource(stream);
      an = ac.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      buf = new Float32Array(an.fftSize);
    } catch { /* no VAD -> fixed window */ }
    let spokeAt = 0, silentSince = 0, t0 = Date.now();
    rec.start(200);
    const timer = setInterval(() => {
      const nowT = Date.now();
      let rms = 1; // no analyser -> pretend speech so the max window applies
      if (an) { an.getFloatTimeDomainData(buf); rms = Math.sqrt(buf.reduce((a, v) => a + v * v, 0) / buf.length); }
      if (rms > threshold) { if (!spokeAt) spokeAt = nowT; silentSince = 0; }
      else if (spokeAt && !silentSince) silentSince = nowT;
      const spokeLong = spokeAt && nowT - spokeAt > minSpeechMs;
      const silentLong = silentSince && nowT - silentSince > silenceMs;
      const noSpeech = !spokeAt && nowT - t0 > graceMs;
      if (V.stopFlag || noSpeech || nowT - t0 > maxMs || (spokeLong && silentLong)) {
        clearInterval(timer);
        try { src?.disconnect(); } catch {}
        rec.onstop = () => resolve((spokeAt || !an) && !noSpeech ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null);
        try { rec.stop(); } catch { resolve(null); }
      }
    }, 120);
  });
}

// ---- voice reply (mic → /api/transcribe → review sheet) ------------------------------------------
async function startRec() {
  stopSpeech();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    S.rec = { t0: Date.now(), timer: setInterval(() => { const el = $('#rec-time'); if (el) el.textContent = recClock(); }, 500), media: rec, chunks: [], stream };
    rec.ondataavailable = (e) => { if (e.data?.size) S.rec.chunks.push(e.data); };
    rec.start(250);
    S.sheet = 'rec';
    render();
  } catch (e) {
    toast('Mic unavailable: ' + (e.message || e));
  }
}
function recClock() {
  const s = Math.floor((Date.now() - S.rec.t0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function killRec(keep) {
  clearInterval(S.rec.timer);
  try { S.rec.media?.stop(); } catch {}
  try { S.rec.stream?.getTracks().forEach((t) => t.stop()); } catch {}
  if (!keep) S.rec = { t0: 0, timer: null, media: null, chunks: [] };
}
async function stopRecAndReview() {
  const { media, chunks } = S.rec;
  const mime = media?.mimeType || 'audio/webm';
  await new Promise((res) => { if (!media || media.state === 'inactive') return res(); media.onstop = res; try { media.stop(); } catch { res(); } });
  killRec(true);
  S.sheet = 'review';
  S.draft = '…';
  render();
  try {
    const blob = new Blob(chunks, { type: mime });
    if (blob.size < 600) throw new Error('no audio captured');
    const r = await fetch('api/transcribe?polish=false', { method: 'POST', headers: { 'content-type': mime }, body: blob });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'transcribe failed');
    S.draft = j.text || '';
  } catch (e) {
    S.draft = '';
    toast('Transcription failed: ' + (e.message || e));
  }
  S.rec = { t0: 0, timer: null, media: null, chunks: [] };
  render();
  const ta = $('#review-ta');
  if (ta) { ta.value = S.draft; ta.focus(); }
}
function cancelRec() {
  killRec(false);
  S.sheet = null;
  S.draft = '';
  render();
}

// ---- actions -----------------------------------------------------------------------------------
async function sendReply(text) {
  const t = String(text || '').trim();
  if (!t || !S.sid) return;
  stopSpeech();
  try {
    const r = await fetch(`api/session/${S.sid}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t, source: 'text' }) });
    if (r.status === 409) {
      await api(`api/session/${S.sid}/resume`, { method: 'POST' }).catch(() => {});
      toast('Resuming — send again in a moment');
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    draftSet(S.sid, ''); S.text = ''; S.typing = false; S.draft = ''; S.sheet = null;
    toast('Sent — session resumed');
    loadDetail(S.sid); loadHome();
  } catch (e) {
    toast('Send failed: ' + (e.message || e));
  }
}
const KEYS = [
  { label: 'Enter', data: '\r' }, { label: 'Esc', data: '' }, { label: 'Tab', data: '\t' },
  { label: '1', data: '1' }, { label: '2', data: '2' }, { label: '3', data: '3' },
  { label: 'y', data: 'y' }, { label: 'n', data: 'n' }, { label: '^C', data: '' },
];
async function sendKey(k) {
  if (!S.sid) return;
  try {
    await api(`api/session/${S.sid}/type`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: k.data }) });
    if (k.label === '^C') toast('Interrupt sent');
    // a key answers the current ask: mark this session's unread read (design read-semantics)
    const un = unreadOf(S.detail);
    if (un.length) markRead(un.map((m) => m.id));
  } catch (e) { toast('Key failed: ' + (e.message || e)); }
}

// Composer drafts are PER-SESSION — keyed by session id (same localStorage key as the desktop composer, so
// an unsent draft even follows you between phone and desktop). Typing in one session never bleeds into
// another, and switching back restores your in-progress prompt. (Bug this fixes: S.text was one global.)
const draftKey = (sid) => 'aios_draft_' + sid;
const draftGet = (sid) => { try { return (sid && localStorage.getItem(draftKey(sid))) || ''; } catch { return ''; } };
const draftSet = (sid, v) => { try { if (!sid) return; v ? localStorage.setItem(draftKey(sid), v) : localStorage.removeItem(draftKey(sid)); } catch {} };

// ---- navigation (history-backed so hardware/gesture back works in the PWA) ----------------------
function nav(screen, sid = null, push = true) {
  stopSpeech();
  S.screen = screen; S.sid = sid; S.overlay = null; S.sheet = null; S.typing = false; S.killArmed = false;
  S.text = draftGet(sid); // restore THIS session's unsent composer text (empty for home / a fresh session)
  if (screen === 'session' && sid) { S.detail = null; loadDetail(sid); }
  if (push) history.pushState({ screen, sid }, '', location.pathname + (screen === 'home' ? '#home' : `#s/${sid}`)); // path-anchored: <base href="./"> makes bare-hash URLs resolve to the site root
  render();
}
function openCanonicalSession(sid) {
  if (!sid) return;
  location.href = `session?id=${encodeURIComponent(sid)}&from=phone`;
}
window.addEventListener('popstate', () => {
  if (S.overlay || S.sheet) { S.overlay = null; S.sheet = null; render(); return; }
  const h = location.hash;
  const m = h.match(/^#s\/(.+)$/);
  if (m) openCanonicalSession(m[1]);
  else nav('home', null, false);
});
function openOverlay(kind) {
  S.overlay = kind;
  history.pushState({ overlay: kind }, '', location.pathname + location.hash); // back closes the overlay
  render();
}
function openSheet(kind) {
  S.sheet = kind; S.killArmed = false;
  render();
}

// ---- interaction-aware rendering -----------------------------------------------------------------
// Background refreshes (SSE/poll) must NEVER clobber what the user is doing: no scroll resets, no
// sheet/composer teardown, no focus loss. Data still lands in S; the DOM catches up at the next safe
// moment (interaction idle, nav, or an explicit action render).
let lastInteract = 0;
let renderDirty = false;
for (const ev of ['touchstart', 'pointerdown', 'wheel']) {
  window.addEventListener(ev, () => { lastInteract = Date.now(); }, { passive: true });
}
function interacting() {
  return !!(S.sheet || S.overlay || S.typing || Date.now() - lastInteract < 3500);
}
function renderSoft() {
  if (interacting()) { renderDirty = true; scheduleCatchup(); return; }
  render();
}
let catchupTimer = null;
function scheduleCatchup() {
  clearTimeout(catchupTimer);
  catchupTimer = setTimeout(() => { if (renderDirty && !interacting()) { renderDirty = false; render(); } else if (renderDirty) scheduleCatchup(); }, 1200);
}

// ---- render ------------------------------------------------------------------------------------
function render() {
  const parts = [];
  if (S.screen === 'home') parts.push(renderHome());
  else parts.push(renderSession());
  if (S.overlay === 'report') parts.push(renderReport());
  if (S.overlay === 'raw') parts.push(renderRaw());
  if (S.sheet) parts.push(renderSheet());
  if (S.toast) parts.push(`<div class="toast">${esc(S.toast)}</div>`);
  const prevScroll = { msgs: $('#msgs')?.scrollTop, home: app.querySelector('.home-scroll')?.scrollTop };
  app.innerHTML = parts.join('');
  wire();
  const homeBox = app.querySelector('.home-scroll');
  if (homeBox && prevScroll.home != null) homeBox.scrollTop = prevScroll.home;
  // session opens at the conversation's end (the NEW divider / latest message), like any messenger;
  // subsequent re-renders keep the user's scroll position unless they were already at the bottom.
  const box = $('#msgs');
  if (box) {
    const nd = box.querySelector('.newdiv');
    const hasMsgs = !!box.querySelector('.acard, .ubub');
    if (S._scrollSid !== S.sid) {
      if (hasMsgs) { // anchor only once real messages exist (the boot render is empty)
        S._scrollSid = S.sid;
        if (nd) nd.scrollIntoView({ block: 'start' });
        else box.scrollTop = box.scrollHeight;
      }
    } else if (S._nearBottom) {
      box.scrollTop = box.scrollHeight;
    } else if (prevScroll.msgs != null) {
      box.scrollTop = prevScroll.msgs; // mid-history reading position survives re-renders
    }
    box.onscroll = () => { S._nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120; };
  }
}

function renderHome() {
  const sessions = S.home?.sessions || [];
  const counts = S.home?.counts || { waiting: 0, working: 0, live: 0 };
  const live = sessions.filter((s) => ['working', 'waiting'].includes(s.status) && !s.parked);
  const needs = phoneNeeds();
  const dismissed = sessions.filter((s) => s.dismissed)
    .sort((a, b) => Number(b.dismissed_at || 0) - Number(a.dismissed_at || 0));
  const stale = sessions.filter((s) => !s.dismissed && (s.parked || (s.status === 'waiting' && Date.now() - s.last_activity > 48 * 3600e3)) && !needs.includes(s));
  const totalUnread = needs.length; // one KEY message per session (the curated latest ask) — raw out-message counts are noisy
  const voiceActive = isVoiceModeActive();
  const playing = S.playScope === 'home' || voiceActive;
  const playLabel = voiceActive ? '■ End Voice Assistant' : totalUnread ? '▶ Start Voice Assistant' : 'Voice Assistant';

  const optionList = (s, questions) => {
    if (!questions.length) return '';
    const selections = phoneSelections(s);
    const hasMulti = questions.some((question) => question.multiSelect);
    return `<div class="needqs">
      ${questions.map((question, questionIndex) => `
        <div class="needq">
          ${questions.length > 1 || question.header ? `<div class="needq-head">${esc(question.header || `Question ${questionIndex + 1}`)}</div>` : ''}
          ${question.question ? `<div class="needq-text">${esc(question.question)}</div>` : ''}
          <div class="needopts">${question.options.map((option, optionIndex) => {
            const selected = selections.get(questionIndex)?.has(optionIndex);
            return `<button class="needopt${selected ? ' selected' : ''}" data-need-choice="${esc(s.id)}" data-question="${questionIndex}" data-option="${optionIndex}" aria-pressed="${selected ? 'true' : 'false'}"><span>${option.key ? `${esc(option.key)} — ` : ''}${esc(option.label)}</span>${option.description ? `<small>${esc(option.description)}</small>` : ''}</button>`;
          }).join('')}</div>
        </div>`).join('')}
      ${hasMulti ? `<button class="need-send" data-need-send="${esc(s.id)}" ${phoneChoicesComplete(questions, selections) && !submittingChoices.has(s.id) ? '' : 'disabled'}>${submittingChoices.has(s.id) ? 'Sending choices…' : 'Send selected options'}</button>` : `<span class="needq-hint">${questions.length > 1 ? 'Choose one for each — sends after the last choice' : 'Choose an option to answer'}</span>`}
    </div>`;
  };
  const needCards = needs.map((s) => {
    const [bLabel, bColor] = badgeFor(s) || ['REVIEW', '#3fbf5f'];
    const isPlaying = S.playScope === 'home' && S.speakingId === s.last_key?.id;
    const questions = phoneOptionQuestions(s);
    const preview = attentionPreview(s, { optionCount: questions.length });
    const handledReview = s.category === 'review' && preview.actionSource === 'default';
    const showNext = preview.need && !handledReview && !questions.length;
    const outcomeMark = s.category === 'review' ? '✓' : s.category === 'decision' ? '◆' : '!';
    ensureOptionQuestions(s, () => renderSoft());
    return `
    <div class="needcard" data-open="${esc(s.id)}">
      <div class="strip" style="background:${bColor}"></div>
      <div class="needrow">
        <span class="badge" style="color:${bColor}">${bLabel}</span>
        <span class="needproject">${esc(s.project || s.id)} · ${esc(AGENT_LABEL[s.tool] || s.tool)}</span>
        ${isPlaying ? '<span class="reading-ind">▶ reading</span>' : ''}
        <span class="needtime">${ago(s.last_activity)}</span>
      </div>
      <div class="needrequest">${esc(preview.request)}</div>
      ${preview.outcome ? `<div class="needoutcome"><span aria-hidden="true" style="color:${bColor}">${outcomeMark}</span><p>${esc(preview.outcome)}</p></div>` : ''}
      ${showNext ? `<div class="neednext"><span aria-hidden="true">→</span><b>${esc(preview.need)}</b></div>` : ''}
      ${optionList(s, questions)}
      <div class="needacts">
        <button class="act listen" data-listen="${esc(s.id)}">${isPlaying ? '■ Stop' : '▶ Listen'}</button>
        ${handledReview
          ? `<button class="act reply" data-open2="${esc(s.id)}">Review result</button>`
          : `<button class="act reply" data-replyto="${esc(s.id)}">Reply</button>`}
        <button class="act dismiss" data-dismiss-need="${esc(s.id)}">Dismiss</button>
      </div>
    </div>`;
  }).join('');
  const dismissedRows = dismissed.map((s) => `
    <div class="ph-dismissed-row" data-open="${esc(s.id)}">
      <div class="ph-dismissed-copy">
        <b>${esc(s.title || s.id)}</b>
        <span>${esc(String(s.dismissed_report_text || s.question || s.summary || '').slice(0, 180))}</span>
      </div>
      <span class="ph-dismissed-time">${ago(s.dismissed_at)}</span>
      <button data-restore-attention="${esc(s.id)}">Restore</button>
    </div>`).join('');

  const sessRow = (s) => `
    <button class="sessrow" data-open="${esc(s.id)}">
      <span class="dot ${s.status === 'working' ? 'pulse' : ''}" style="background:${statusColor(s.status)}"></span>
      <span class="sessname">${esc(s.title || s.id)}</span>
      <span class="sesstask">${esc(s.summary || s.question || '')}</span>
      <span class="sessstatus" style="color:${statusColor(s.status)}">${statusWord(s.status)}</span>
      <span class="sesstime">${ago(s.last_activity)}</span>
    </button>`;
  const rows = live.filter((s) => !needs.includes(s) && !s.dismissed).map(sessRow).join('');
  // Every session, not just the live ones (operator: the mobile view must reach ALL sessions).
  const others = sessions.filter((s) => !['working', 'waiting'].includes(s.status));
  const otherRows = others.map(sessRow).join('');

  return `
  <div class="screen">
    <div class="ph-head">
      <div class="ph-brandrow">
        <span class="ph-brand">Supercalm</span>
        <span style="flex:1"></span>
        <span class="pill wait">${counts.waiting} waiting</span>
        <span class="pill work">${counts.working} working</span>
        <span class="pill">${counts.live} live</span>
      </div>
      <div class="ph-voicebar">
        <button class="playbig ${totalUnread || playing ? '' : 'inert'}" id="play-home">${playLabel}</button>
        <button class="ongobig ${onTheGoUi.enabled ? 'on' : ''}" id="on-the-go-mode" type="button" aria-pressed="${onTheGoUi.enabled ? 'true' : 'false'}" title="${esc(onTheGoUi.detail || '')}">
          <span></span>${onTheGoUi.talking ? 'Talking…' : onTheGoUi.incoming ? 'Incoming…' : onTheGoUi.enabled ? `Voice updates · ${onTheGoUi.style === 'call' ? 'Call' : 'Walkie'}` : 'Voice updates'}
        </button>
      </div>
      ${onTheGoUi.enabled ? `
        <div class="ph-voice-style" role="group" aria-label="Voice update style">
          <button type="button" data-voice-update-style="call" aria-pressed="${onTheGoUi.style === 'call' ? 'true' : 'false'}" class="${onTheGoUi.style === 'call' ? 'active' : ''}">Call</button>
          <button type="button" data-voice-update-style="walkie" aria-pressed="${onTheGoUi.style === 'walkie' ? 'true' : 'false'}" class="${onTheGoUi.style === 'walkie' ? 'active' : ''}">Walkie-talkie</button>
        </div>
        <div class="ongo-note">${esc(onTheGoUi.detail)}</div>` : ''}
    </div>
    <div class="scroll home-scroll">
      <div class="sec-label">NEEDS YOU <span class="cnt">${needs.length}</span><button class="ph-needs-refresh" id="refresh-needs" aria-label="Refresh Needs you from the server">↻ Refresh</button></div>
      ${needs.length ? needCards : `
        <div class="allclear"><span class="check">✓</span><span class="t">All clear — nothing needs you.</span></div>`}
      ${stale.length ? `<div class="stale-strip">▸ ${stale.length} stale session${stale.length === 1 ? '' : 's'} waiting — no touch from you in days (replying re-heats)</div>` : ''}
      ${dismissed.length ? `<section class="ph-dismissed">
        <button class="ph-dismissed-toggle" id="toggle-dismissed" aria-expanded="${S.dismissedOpen ? 'true' : 'false'}">
          <span>${S.dismissedOpen ? '▾' : '▸'}</span> DISMISSED <span class="cnt neutral">${dismissed.length}</span>
        </button>
        ${S.dismissedOpen ? `<div class="ph-dismissed-rows">${dismissedRows}</div>` : ''}
      </section>` : ''}
      <div class="sec-label" style="padding-top:10px">SESSIONS</div>
      ${rows || '<div class="stale-strip">no other live sessions</div>'}
      <div class="sec-label" style="padding-top:12px">SYSTEM</div>
      <nav class="ph-sysnav">
        <a href="decisions">Decisions</a>
        <a href="records">Records</a>
        <a href="usage">Usage</a>
        <a href="health">Health</a>
        <a href="settings">Settings</a>
        <a href="./?desktop=1">Desktop site ›</a>
      </nav>
      ${others.length ? `<div class="sec-label" style="padding-top:12px">ALL SESSIONS <span class="cnt neutral">${others.length}</span></div>${otherRows}` : ''}
      <div class="ph-app-foot"><button type="button" data-aios-update data-aios-version>${S.appVersion ? `v${esc(S.appVersion)}` : 'Check for update'}</button><span>tap to refresh the installed app</span></div>
    </div>
  </div>`;
}

function renderSession() {
  const d = S.detail;
  const s = d || (S.home?.sessions || []).find((x) => x.id === S.sid) || { id: S.sid };
  const un = unreadOf(d);
  const playing = S.playScope === 'sess';
  const msgs = (d?.messages || []).slice(-60);
  const firstUnreadId = un[0]?.id;

  const curatedAsk = typeof s.question === 'string' && s.question.trim() ? s.question.trim() : '';
  const msgHtml = msgs.map((m) => {
    const divider = m.id === firstUnreadId ? '<div class="newdiv"><span class="rule"></span><span class="t">NEW</span><span class="rule"></span></div>' : '';
    if (m.direction === 'in') {
      return divider + `<div class="ubub"><span class="pfx">❯ </span>${esc(m.text)}</div>`;
    }
    const unread = !m.read_at && un.some((x) => x.id === m.id);
    // the latest unread card shows the summarizer's curated ask (the raw tail is a noisy capture)
    const text = (unread && m.id === un[un.length - 1]?.id && curatedAsk) ? curatedAsk : cleanTail(m.text);
    const isPlaying = S.speakingId === m.id;
    const report = isReport(text);
    const body = report
      ? `<div class="body">${esc(headlineOf(text))}</div>
         <div class="digest">${digestOf(text).map((b) => `<div class="li"><span class="m">–</span><span>${esc(b)}</span></div>`).join('')}</div>
         <button class="openreport" data-report="${m.id}">▤ Open full report</button>`
      : `<div class="body">${esc(text)}</div>`;
    return divider + `
    <div class="acard" data-mid="${m.id}">
      <div class="metarow">
        ${unread ? '<span class="udot"></span>' : ''}
        <span class="meta">agent · ${hhmm(m.ts)}</span>
        ${isPlaying ? '<span class="reading-ind">reading…</span>' : ''}
        <button class="mplay" data-play="${m.id}">${isPlaying ? '■' : '▶'}</button>
      </div>
      ${body}
    </div>`;
  }).join('');

  const status = statusWord(s.status);
  return `
  <div class="screen">
    <div class="sv-head">
      <button class="sq back" id="go-home">‹</button>
      <div class="sv-titlebox">
        <div class="sv-titlerow">
          <span class="sv-name">${esc(s.title || s.id || '')}</span>
          <span class="agchip" style="color:${chipColor(s.tool)};border-color:${chipColor(s.tool)}8c">${esc(AGENT_LABEL[s.tool] || s.tool || '')}</span>
        </div>
        <div class="sv-sub">${esc([s.model, s.autonomy].filter(Boolean).join(' · '))}</div>
      </div>
      <button class="sq" id="open-actions">⋯</button>
    </div>
    <button class="sv-strip" id="open-panels">
      <span class="st"><span class="dot ${s.status === 'working' ? 'pulse' : ''}" style="background:${statusColor(s.status)}"></span><span style="color:${statusColor(s.status)}">${status}</span></span>
      <span class="hint">panels ›</span>
    </button>
    ${un.length ? `<div class="sv-playwrap"><button class="playsess" id="play-sess">${playing ? '■ Stop reading' : `▶ Play ${un.length} unread`}</button></div>` : ''}
    <div class="scroll msgs" id="msgs">${msgHtml || '<div class="stale-strip">no messages yet</div>'}</div>
    <div class="composer">
      ${S.keysOpen ? `<div class="keychips">${KEYS.map((k, i) => `<button class="keychip" data-key="${i}">${esc(k.label)}</button>`).join('')}</div>` : ''}
      <div class="comprow">
        <button class="kbtoggle" id="toggle-keys">⌨</button>
        ${S.typing
          ? `<textarea class="realfield" id="real-ta" rows="2" placeholder="Ask anything…">${esc(S.text)}</textarea>
             <button class="sendbtn" id="send-text">↑</button>`
          : `<button class="fakefield" id="fake-field">Ask anything…</button>
             <button class="micbtn" id="mic" aria-label="record a voice reply">
               <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="11" rx="3" fill="#fff"/><path d="M6 11a6 6 0 0 0 12 0" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/><line x1="12" y1="17" x2="12" y2="21" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>
             </button>`}
      </div>
    </div>
  </div>`;
}

function renderReport() {
  const m = S.reportMsg;
  if (!m) return '';
  const s = S.detail || {};
  const playing = S.playScope === 'report';
  return `
  <div class="ov">
    <div class="ov-head">
      <button class="sq back" data-close-overlay>‹</button>
      <div class="ov-titlebox">
        <span class="ov-title">Report</span>
        <span class="ov-sub">${esc([s.title || s.id, AGENT_LABEL[s.tool] || s.tool, hhmm(m.ts)].filter(Boolean).join(' · '))}</span>
      </div>
    </div>
    <div class="scroll rp-scroll">
      <div class="rp-headline">${esc(headlineOf(m.text))}</div>
      <button class="rp-listen" id="play-report">${playing ? '■ Stop reading' : '▶ Listen to full report'}</button>
      <div class="rp-sec"><div class="h">KEY POINTS</div>
        <div class="digest">${digestOf(m.text).map((b) => `<div class="li" style="font-size:13.5px"><span class="m">–</span><span>${esc(b)}</span></div>`).join('') || '<span class="pfoot">—</span>'}</div>
      </div>
      <div class="rp-md">${renderMarkdown(m.text)}</div>
    </div>
  </div>`;
}

function renderRaw() {
  const s = S.detail || {};
  return `
  <div class="ov raw">
    <div class="ov-head">
      <button class="sq back" data-close-overlay>‹</button>
      <div class="ov-titlebox">
        <span class="ov-title">Raw transcript</span>
        <span class="ov-sub">${esc(s.title || s.id || '')} · full terminal view</span>
      </div>
    </div>
    <div class="scroll"><pre class="rawpre">${esc(S.rawText || 'loading…')}</pre></div>
  </div>`;
}

function renderSheet() {
  const scrim = '<button class="scrim" data-close-sheet aria-label="close"></button>';
  if (S.sheet === 'voicemode') {
    const st = V.state;
    const label = st === 'speaking' ? 'Speaking…' : st === 'listening' ? 'Listening — pause to send' : st === 'thinking' ? 'Thinking…' : 'Starting…';
    const project = V.current?.projectIdentity || V.current?.project || 'Project update';
    const context = V.current
      ? phoneVoiceThreadLabel(V.current) || V.current.category
      : 'Needs You';
    const progress = V.current?.total ? `${V.current.n} of ${V.current.total}` : '';
    const heard = V.ignoredReason === 'no-speech'
      ? 'No response heard. Nothing was sent.'
      : V.ignoredReason === 'fragment'
        ? 'A clipped sound was ignored. Still listening.'
        : V.lastHeard
          ? `“${V.lastHeard.slice(0, 260)}”`
          : st === 'listening' ? 'Listening — your words will appear here.' : 'Your response will stay here.';
    const heardLabel = V.ignoredReason === 'no-speech'
      ? 'NO RESPONSE · NOTHING SENT'
      : V.ignoredReason === 'fragment'
        ? 'AUDIO FRAGMENT · NOT USED'
      : V.ignoredReason
        ? 'HEARD NEARBY · NOT USED'
        : V.lastHeard ? 'YOUR LAST RESPONSE' : 'YOUR RESPONSE';
    const sourceNames = [...new Set((V.current?.sourceNames || []).map((name) => String(name || '').trim()).filter(Boolean))].slice(0, 4);
    const spokenLabel = V.lastHeard
      ? V.responseGrounded ? 'SOURCE-GROUNDED RESPONSE' : 'ASSISTANT RESPONSE'
      : 'BRIEFING';
    if (V.onTheGo) return `
    <button class="scrim" data-voice-end aria-label="end"></button>
    <div class="sheet ongoing-sheet">
      <div class="ongo-sheet-head">
        <div><span class="ongo-sheet-kicker">VOICE ASSISTANT</span><div class="ongo-sheet-title">${esc(project)}</div></div>
        <div class="ongo-sheet-live"><i></i>${esc(label)}</div>
      </div>
      <div class="ongo-sheet-progress"><span>${esc(context || 'Needs You')}</span><b>${esc(progress)}</b></div>
      ${sourceNames.length ? `<div class="ongo-sheet-sources" aria-label="Report sources">${sourceNames.map((name) => `<span>${esc(name)}</span>`).join('')}</div>` : ''}
      <div class="ongo-sheet-report">
        <span>${spokenLabel}</span>
        <p>${esc(V.segment || 'Preparing a clear update…')}</p>
      </div>
      <div class="ongo-sheet-heard ${V.ignoredReason ? 'ignored' : ''}"><b>${heardLabel}</b><span>${esc(heard)}</span></div>
      ${V.delivery ? `<div class="ongo-sheet-delivery ${V.delivery.status === 'sent' ? '' : 'failed'}">${V.delivery.status === 'sent' ? `✓ Sent to ${esc(V.delivery.project)}${V.sentCount > 1 ? ` · ${V.sentCount} sent` : ''}` : `Not sent · ${esc(String(V.delivery.status || 'delivery failed').replace(/-/g, ' '))}`}</div>` : ''}
      <div class="wave" style="${st === 'listening' ? '' : 'opacity:.25'}">${[-0.9, -0.7, -0.5, -0.3, -0.6, -0.15, -0.45].map((d, i) => `<span style="height:${[20, 32, 42, 26, 38, 22, 34][i]}px;animation-delay:${d}s"></span>`).join('')}</div>
      <div class="sheetrow">${st === 'speaking' ? '<button class="sbtn" data-voice-interrupt>Speak now</button>' : ''}<button class="sbtn neutral" data-voice-end>■ End assistant</button></div>
      <div class="footnote">ask follow-ups naturally · instructions are confirmed before anything is sent</div>
    </div>`;
    return `
    <button class="scrim" data-voice-end aria-label="end"></button>
    <div class="sheet">
      <div class="rec-status">
        <span class="rec-dot" style="${st === 'listening' ? '' : 'background:var(--teal)'}"></span>
        <span>${esc(label)}</span>
      </div>
      ${V.current ? `<div class="footnote">${esc([project, context, progress].filter(Boolean).join(' · '))}</div>` : ''}
      ${V.lastHeard ? `<div class="pm-goal" style="text-align:center;color:var(--tx-2)">“${esc(V.lastHeard.slice(0, 160))}”</div>` : ''}
      <div class="wave" style="${st === 'listening' ? '' : 'opacity:.25'}">${[-0.9, -0.7, -0.5, -0.3, -0.6, -0.15, -0.45].map((d, i) => `<span style="height:${[20, 32, 42, 26, 38, 22, 34][i]}px;animation-delay:${d}s"></span>`).join('')}</div>
      <div class="sheetrow">
        ${st === 'speaking' ? '<button class="sbtn" data-voice-interrupt>Speak now</button>' : ''}
        <button class="sbtn neutral" data-voice-end>■ End</button>
      </div>
      <div class="footnote">say “skip” for the next item · “stop” to end · ask any question about the session or project</div>
    </div>`;
  }
  if (S.sheet === 'rec') {
    return scrim + `
    <div class="sheet">
      <div class="rec-status"><span class="rec-dot"></span><span>Listening…</span><span class="rec-time" id="rec-time">${recClock()}</span></div>
      <div class="wave">${[-0.9, -0.7, -0.5, -0.3, -0.6, -0.15, -0.45].map((d, i) => `<span style="height:${[20, 32, 42, 26, 38, 22, 34][i]}px;animation-delay:${d}s"></span>`).join('')}</div>
      <div class="sheetrow">
        <button class="sbtn neutral" data-close-sheet>Cancel</button>
        <button class="sbtn primary" id="rec-stop">■ Stop &amp; review</button>
      </div>
    </div>`;
  }
  if (S.sheet === 'review') {
    return scrim + `
    <div class="sheet">
      <div class="sheet-label">YOUR REPLY — CHECK BEFORE SEND</div>
      <textarea class="reviewbox" id="review-ta" rows="4">${esc(S.draft)}</textarea>
      <div class="sheetrow">
        <button class="sbtn neutral" id="re-rec">● Re-record</button>
        <button class="sbtn primary" id="send-voice">Send ↑</button>
      </div>
      <div class="footnote">sends as text · session resumes</div>
    </div>`;
  }
  if (S.sheet === 'actions') {
    return scrim + `
    <div class="sheet" style="padding:14px 14px calc(var(--sab) + 24px);gap:8px">
      <button class="actionrow" id="act-raw">▤ Raw transcript</button>
      <button class="actionrow" id="act-stop">◼ Stop session</button>
      <button class="actionrow danger" id="act-kill">${S.killArmed ? 'Tap again to confirm kill' : 'Kill session'}</button>
      <button class="actionrow plain" data-close-sheet>Cancel</button>
    </div>`;
  }
  if (S.sheet === 'panels') {
    return scrim + `
    <div class="sheet tall">
      <div class="pn-head"><span class="pn-title">Session panels</span><button class="pn-x" data-close-sheet>✕</button></div>
      <div class="pn-tabs" id="pn-host-tabs"></div>
      <div class="pn-body" id="pn-host-panels"></div>
    </div>`;
  }
  return '';
}

// The panels sheet hosts the REAL desktop agent panels (Graph/Supervisor/Knowledge/Usage/…): same
// modules, same registry, mounted into the sheet (no phone re-implementations, no placeholders).
function mountPanels() {
  requestAnimationFrame(() => {
    const tabsEl = $('#pn-host-tabs');
    const panelsEl = $('#pn-host-panels');
    if (!tabsEl || !panelsEl || !S.sid) return;
    try { initAgentPanel({ sessionId: S.sid, tabsEl, panelsEl }); } catch (e) { panelsEl.innerHTML = `<div class="pn-placeholder"><span class="a">panels failed</span><span class="b">${esc(e.message || e)}</span></div>`; }
  });
}

// ---- wiring (event delegation after each render) ---------------------------------------------------
function wire() {
  // home
  $('#toggle-dismissed')?.addEventListener('click', () => {
    S.dismissedOpen = !S.dismissedOpen;
    render(); // explicit disclosure action: paint immediately even inside the interaction guard window
  });
  for (const el of app.querySelectorAll('[data-restore-attention]')) el.addEventListener('click', async (event) => {
    event.stopPropagation();
    const sid = el.dataset.restoreAttention;
    el.disabled = true;
    try {
      const result = await api(`api/attention/${sid}/restore`, { method: 'POST' });
      patchSession({
        session: sid,
        unread: Number(result?.unread) || 0,
        dismissed: false,
        dismissed_at: null,
        dismissed_report_id: null,
        dismissed_report_text: null,
        source: 'attention-restore',
      });
      toast(result?.reopened ? 'Restored to Needs you' : 'Removed from Dismissed');
    } catch (error) {
      el.disabled = false;
      toast('Restore failed: ' + (error.message || error));
    }
  });
  $('#refresh-needs')?.addEventListener('click', async () => {
    const button = $('#refresh-needs');
    if (button) { button.disabled = true; button.textContent = '↻ Refreshing…'; }
    const ok = await loadHome();
    toast(ok ? 'Needs you refreshed' : 'Refresh failed — showing the last known list');
  });
  $('#play-home')?.addEventListener('click', () => {
    if (isVoiceModeActive()) return stopVoiceMode();
    stopSpeech();
    startVoiceMode({ source: 'manual' }); // the same gesture-unlocked client used by desktop + PWA updates
  });
  $('#on-the-go-mode')?.addEventListener('click', async () => {
    const button = $('#on-the-go-mode');
    if (button) button.disabled = true;
    await toggleOnTheGo();
    if (S.screen === 'home') renderSoft();
  });
  for (const button of app.querySelectorAll('[data-voice-update-style]')) {
    button.addEventListener('click', () => {
      setVoiceUpdateStyle(button.dataset.voiceUpdateStyle);
      if (S.screen === 'home') render();
    });
  }
  // The phone surface is the triage inbox, not a second session app. Open the canonical responsive
  // Story/Terminal view so attachments, dictation, panels, and future composer work stay shared.
  for (const el of app.querySelectorAll('[data-open]')) el.addEventListener('click', () => openCanonicalSession(el.dataset.open));
  for (const el of app.querySelectorAll('[data-open2]')) el.addEventListener('click', (e) => { e.stopPropagation(); openCanonicalSession(el.dataset.open2); });
  for (const el of app.querySelectorAll('[data-listen]')) el.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = (S.home?.sessions || []).find((x) => x.id === el.dataset.listen);
    if (!s) return;
    if (S.playScope === 'home' && S.speakingId === s.last_key?.id) return stopSpeech();
    const fallback = s.question || s.summary || s.last_key?.text || '';
    playQueue([{ mid: s.last_key?.id, sid: s.id, text: fallback, briefSid: s.id }], 'home');
  });
  for (const el of app.querySelectorAll('[data-replyto]')) el.addEventListener('click', (e) => {
    e.stopPropagation();
    openCanonicalSession(el.dataset.replyto);
  });
  for (const el of app.querySelectorAll('[data-inspect-need]')) el.addEventListener('click', (event) => {
    event.stopPropagation();
    openCanonicalSession(el.dataset.inspectNeed);
  });
  const submit = async (session, questions) => {
    const selections = phoneSelections(session);
    if (!phoneChoicesComplete(questions, selections) || submittingChoices.has(session.id)) return;
    submittingChoices.add(session.id);
    renderSoft();
    try {
      await api(`api/session/${session.id}/answers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers: answersPayload(questions, selections) }),
      });
      choiceSelections.delete(session.id);
      submittingChoices.delete(session.id);
      patchSession({ session: session.id, status: 'working', question: null, summary: null, category: null, unread: 0, source: 'option-answer' });
      toast('Choices sent — session resumed');
    } catch (error) {
      submittingChoices.delete(session.id);
      toast('Send failed: ' + (error.message || error));
      renderSoft();
    }
  };
  for (const el of app.querySelectorAll('[data-need-choice]')) el.addEventListener('click', (event) => {
    event.stopPropagation();
    const session = (S.home?.sessions || []).find((item) => item.id === el.dataset.needChoice);
    if (!session) return;
    const questions = phoneOptionQuestions(session);
    const selections = phoneSelections(session);
    const questionIndex = Number(el.dataset.question);
    const optionIndex = Number(el.dataset.option);
    const question = questions[questionIndex];
    if (!question) return;
    let selected = selections.get(questionIndex);
    if (!selected) { selected = new Set(); selections.set(questionIndex, selected); }
    if (question.multiSelect) {
      selected.has(optionIndex) ? selected.delete(optionIndex) : selected.add(optionIndex);
      if (!selected.size) selections.delete(questionIndex);
    } else {
      selections.set(questionIndex, new Set([optionIndex]));
    }
    renderSoft();
    if (!questions.some((item) => item.multiSelect) && phoneChoicesComplete(questions, selections)) submit(session, questions);
  });
  for (const el of app.querySelectorAll('[data-need-send]')) el.addEventListener('click', (event) => {
    event.stopPropagation();
    const session = (S.home?.sessions || []).find((item) => item.id === el.dataset.needSend);
    if (session) submit(session, phoneOptionQuestions(session));
  });
  for (const el of app.querySelectorAll('[data-dismiss-need]')) el.addEventListener('click', async (event) => {
    event.stopPropagation();
    const session = (S.home?.sessions || []).find((item) => item.id === el.dataset.dismissNeed);
    if (!session) return;
    el.disabled = true;
    try {
      const result = await api('api/messages/read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: session.id, dismiss: true, ...(session.last_key?.id ? { through_id: session.last_key.id } : {}) }),
      });
      const wasDismissed = result?.dismissal?.dismissed !== false;
      patchSession({
        session: session.id,
        unread: Number(result?.unread) || 0,
        dismissed: wasDismissed,
        dismissed_at: wasDismissed ? (result?.dismissal?.dismissed_at || Date.now()) : null,
        dismissed_report_id: wasDismissed ? (result?.dismissal?.report_id || session.last_key?.id || null) : null,
        dismissed_report_text: wasDismissed ? (result?.dismissal?.report_text || null) : null,
        source: 'dismiss',
      });
      toast(wasDismissed ? 'Dismissed until the next report' : 'A newer report arrived — still needs you');
    } catch (error) {
      el.disabled = false;
      toast('Dismiss failed: ' + (error.message || error));
    }
  });

  // session
  $('#go-home')?.addEventListener('click', () => {
    nav('home', null, false);
    history.replaceState({ screen: 'home', sid: null }, '', location.pathname + '#home');
  });
  $('#open-actions')?.addEventListener('click', () => openSheet('actions'));
  $('#open-panels')?.addEventListener('click', () => { openSheet('panels'); mountPanels(); });
  $('#play-sess')?.addEventListener('click', () => {
    if (S.playScope === 'sess') return stopSpeech();
    const un = unreadOf(S.detail);
    playQueue(un.map((m) => ({ mid: m.id, sid: S.sid, text: (S.detail?.question && m.id === un[un.length - 1].id) ? S.detail.question : cleanTail(m.text), briefSid: m.id === un[un.length - 1].id ? S.sid : null })), 'sess');
  });
  for (const el of app.querySelectorAll('[data-play]')) el.addEventListener('click', () => {
    const mid = Number(el.dataset.play);
    if (S.speakingId === mid) return stopSpeech();
    const m = (S.detail?.messages || []).find((x) => x.id === mid);
    if (m) {
      const un2 = unreadOf(S.detail);
      const t = (un2[un2.length - 1]?.id === mid && S.detail?.question) ? S.detail.question : cleanTail(m.text);
      playQueue([{ mid, sid: S.sid, text: isReport(t) ? headlineOf(t) + '. ' + digestOf(t).join('. ') : t }], 'one');
    }
  });
  for (const el of app.querySelectorAll('[data-report]')) el.addEventListener('click', () => {
    const m = (S.detail?.messages || []).find((x) => x.id === Number(el.dataset.report));
    if (!m) return;
    const un2 = unreadOf(S.detail);
    const text = (un2[un2.length - 1]?.id === m.id && S.detail?.question) ? S.detail.question : cleanTail(m.text);
    S.reportMsg = { ...m, text };
    openOverlay('report');
  });
  $('#toggle-keys')?.addEventListener('click', () => { S.keysOpen = !S.keysOpen; localStorage.ph_keys = S.keysOpen ? '1' : '0'; render(); });
  for (const el of app.querySelectorAll('[data-key]')) el.addEventListener('click', () => sendKey(KEYS[Number(el.dataset.key)]));
  $('#fake-field')?.addEventListener('click', () => {
    S.typing = true;
    render();
    const ta = $('#real-ta');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  });
  $('#real-ta')?.addEventListener('input', (e) => { S.text = e.target.value; draftSet(S.sid, S.text); });
  $('#real-ta')?.addEventListener('blur', () => { if (!S.text.trim()) { S.typing = false; render(); } });
  $('#send-text')?.addEventListener('click', () => sendReply(S.text));
  $('#mic')?.addEventListener('click', () => startRec());

  // overlays + sheets
  for (const el of app.querySelectorAll('[data-close-overlay]')) el.addEventListener('click', () => history.back());
  for (const el of app.querySelectorAll('[data-voice-interrupt]')) el.addEventListener('click', () => phoneInterrupt?.({ tap: true }));
  for (const el of app.querySelectorAll('[data-voice-end]')) el.addEventListener('click', () => voiceModeEnd('user'));
  for (const el of app.querySelectorAll('[data-close-sheet]')) el.addEventListener('click', () => { if (S.sheet === 'rec') return cancelRec(); S.sheet = null; render(); });
  $('#rec-stop')?.addEventListener('click', () => stopRecAndReview());
  $('#re-rec')?.addEventListener('click', () => { S.sheet = null; render(); startRec(); });
  $('#review-ta')?.addEventListener('input', (e) => { S.draft = e.target.value; });
  $('#send-voice')?.addEventListener('click', () => sendReply(S.draft));
  $('#act-raw')?.addEventListener('click', async () => {
    S.sheet = null;
    S.rawText = '';
    openOverlay('raw');
    try { const r = await api(`api/session/${S.sid}/log?max=120000`); S.rawText = r.text || '(empty)'; } catch (e) { S.rawText = 'unavailable: ' + (e.message || e); }
    render();
  });
  $('#act-stop')?.addEventListener('click', async () => {
    S.sheet = null;
    try { await api(`api/session/${S.sid}/stop`, { method: 'POST' }); toast('Stop signal sent'); } catch (e) { toast('Stop failed: ' + (e.message || e)); }
  });
  $('#act-kill')?.addEventListener('click', async () => {
    if (!S.killArmed) {
      S.killArmed = true;
      render();
      clearTimeout(S.killTimer);
      S.killTimer = setTimeout(() => { S.killArmed = false; render(); }, 2600);
      return;
    }
    clearTimeout(S.killTimer);
    S.sheet = null;
    try { await api(`api/session/${S.sid}/kill`, { method: 'POST' }); toast('Session killed'); loadHome(); } catch (e) { toast('Kill failed: ' + (e.message || e)); }
  });
  $('#play-report')?.addEventListener('click', () => {
    if (S.playScope === 'report') return stopSpeech();
    const m = S.reportMsg;
    if (m) playQueue([{ mid: m.id, text: m.text }], 'report');
  });
}

// ---- boot ---------------------------------------------------------------------------------------
// Retire historical phone-session deep links into the canonical responsive Story/Terminal view.
const bootMatch = location.hash.match(/^#s\/(.+)$/) || (new URLSearchParams(location.search).get('id') ? [null, new URLSearchParams(location.search).get('id')] : null);
if (bootMatch) {
  location.replace(`session?id=${encodeURIComponent(bootMatch[1])}&from=phone`);
} else {
  history.replaceState({ screen: S.screen, sid: S.sid }, '', location.pathname + '#home');
  loadHome();
  render();
}
