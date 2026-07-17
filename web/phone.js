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

import { api, coalesce, escapeHtml as esc, registerSW, renderMarkdown } from './common.js';
import { initAgentPanel } from './agents/host.js';

registerSW();

const app = document.getElementById('app');

// ---- state -------------------------------------------------------------------------------------
const S = {
  screen: 'home', sid: null,
  home: null, // /api/phone/home payload
  detail: null, // /api/session/:id payload for the open session
  overlay: null, // 'report' | 'raw' | null
  reportMsg: null, rawText: '',
  sheet: null, // 'panels' | 'actions' | 'rec' | 'review' | null
  ptab: 'Usage', usage: null,
  typing: false, text: '', keysOpen: localStorage.ph_keys !== '0',
  speakingId: null, playScope: null, // 'home' | 'sess' | 'report' | 'one'
  queue: [],
  rec: { t0: 0, timer: null, media: null, chunks: [] }, draft: '',
  killArmed: false, killTimer: null,
  toast: '', toastTimer: null,
  voiceRate: Number(localStorage.ph_rate || 1.05),
};

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
function statusColor(st) { return st === 'working' ? 'var(--green-dot)' : st === 'exited' ? 'var(--tx-faint)' : st === 'starting' ? 'var(--blue)' : 'var(--yellow)'; }
function statusWord(st) { return st === 'working' ? 'Working' : st === 'exited' ? 'Stopped' : st === 'starting' ? 'Starting' : 'Waiting'; }
function toast(t) {
  S.toast = t;
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => { S.toast = ''; render(); }, 2300);
  render();
}
function hhmm(ts) { const d = new Date(Number(ts)); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

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
  try { S.home = await api('api/phone/home'); } catch { /* keep stale */ }
  if (S.screen === 'home') renderSoft();
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
const refresh = coalesce(() => { loadHome(); if (S.screen === 'session' && S.sid) loadDetail(S.sid); }, 3000);
try {
  const es = new EventSource('api/events');
  es.onmessage = refresh;
  es.addEventListener('changed', refresh);
} catch {}
setInterval(refresh, 20000); // belt-and-suspenders on flaky mobile SSE

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

// ---- spoken briefs (gpt-5.5 via /api/session/:id/brief) -------------------------------------------
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

// ---- TTS (server /api/tts → Audio; speechSynthesis fallback) -------------------------------------
let audioEl = null;
function stopSpeech() {
  S.queue = [];
  S.speakingId = null;
  S.playScope = null;
  if (audioEl) { try { audioEl.pause(); } catch {} audioEl = null; }
  try { speechSynthesis.cancel(); } catch {}
  render();
}
async function speakOne(text) {
  // server TTS first (Spark/provider), browser voice as fallback — resolves on playback end
  try {
    const r = await fetch('api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!r.ok) throw new Error('tts ' + r.status);
    const blob = await r.blob();
    await new Promise((res, rej) => {
      audioEl = new Audio(URL.createObjectURL(blob));
      audioEl.playbackRate = S.voiceRate;
      audioEl.onended = res;
      audioEl.onerror = rej;
      audioEl.play().catch(rej);
    });
    return true;
  } catch {
    return new Promise((res) => {
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = S.voiceRate;
        u.onend = () => res(true);
        u.onerror = () => res(false);
        speechSynthesis.speak(u);
      } catch { res(false); }
    });
  }
}
async function playQueue(items, scope) {
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

// ---- interactive voice mode (home): the desktop concierge, hands-free on the phone ----------------
// start → server presents item (TTS) → we auto-listen (VAD: speech start on energy, end on ~1.4s of
// silence) → STT → /api/voice/turn → confirm-before-send brain (questions answered from session log +
// project knowledge + supervisor notes) → next item, until done or "stop". One tap in, zero after.
const V = { on: false, voiceId: null, state: 'idle', current: null, lastHeard: '', stream: null, ac: null, stopFlag: false };

async function voiceModeStart() {
  stopSpeech();
  try { V.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { toast('Mic unavailable: ' + (e.message || e)); return; }
  V.on = true; V.state = 'starting'; V.stopFlag = false; S.sheet = 'voicemode';
  render();
  try {
    const r = await api('api/voice/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    V.voiceId = r.voiceId; V.current = r.current || null;
    await voiceSay(r.say);
    if (r.done) return voiceModeEnd('done');
    if (r.listen) return voiceLoopListen();
  } catch (e) { toast('Voice mode failed: ' + (e.message || e)); voiceModeEnd('error'); }
}
async function voiceSay(text) {
  if (!text || V.stopFlag) return;
  V.state = 'speaking'; render();
  await speakOne(text);
}
async function voiceLoopListen() {
  if (V.stopFlag) return;
  V.state = 'listening'; V.lastHeard = ''; render();
  const blob = await vadRecord(V.stream, { maxMs: 45000 });
  if (V.stopFlag) return;
  if (!blob || blob.size < 800) { await voiceSay("I didn't hear anything. Say skip, stop, or your reply."); return voiceLoopListen(); }
  V.state = 'thinking'; render();
  let text = '';
  try {
    const r = await fetch('api/transcribe?polish=false', { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob });
    const j = await r.json();
    text = (j.text || '').trim();
  } catch {}
  if (V.stopFlag) return;
  if (!text) { await voiceSay('Sorry, I could not transcribe that. Try again.'); return voiceLoopListen(); }
  V.lastHeard = text; render();
  try {
    const r = await api('api/voice/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voiceId: V.voiceId, userText: text }) });
    V.current = r.current || V.current;
    await voiceSay(r.say);
    if (V.stopFlag) return;
    if (r.done) return voiceModeEnd('done');
    if (r.listen) return voiceLoopListen();
    // sent/skipped -> ask the server to present the next item
    const c = await api('api/voice/continue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voiceId: V.voiceId }) });
    V.current = c.current || null;
    await voiceSay(c.say);
    if (V.stopFlag) return;
    if (c.done) return voiceModeEnd('done');
    return voiceLoopListen();
  } catch (e) { toast('Voice turn failed: ' + (e.message || e)); return voiceModeEnd('error'); }
}
function voiceModeEnd(why) {
  V.stopFlag = true; V.on = false; V.state = 'idle';
  try { V.stream?.getTracks().forEach((t) => t.stop()); } catch {}
  V.stream = null;
  if (V.voiceId) api('api/voice/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voiceId: V.voiceId }) }).catch(() => {});
  V.voiceId = null;
  stopSpeech();
  if (S.sheet === 'voicemode') S.sheet = null;
  if (why === 'done') loadHome();
  render();
}
// energy-gated recorder: resolves with the utterance blob once the speaker pauses
function vadRecord(stream, { maxMs = 45000, silenceMs = 1400, minSpeechMs = 500, threshold = 0.017 } = {}) {
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
      if (V.stopFlag || nowT - t0 > maxMs || (spokeLong && silentLong)) {
        clearInterval(timer);
        try { src?.disconnect(); } catch {}
        rec.onstop = () => resolve(spokeAt || !an ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null);
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
  if (screen === 'session' && sid) { S.detail = null; S.usage = null; loadDetail(sid); loadUsage(); }
  if (push) history.pushState({ screen, sid }, '', location.pathname + (screen === 'home' ? '#home' : `#s/${sid}`)); // path-anchored: <base href="./"> makes bare-hash URLs resolve to the site root
  render();
}
window.addEventListener('popstate', () => {
  if (S.overlay || S.sheet) { S.overlay = null; S.sheet = null; render(); return; }
  const h = location.hash;
  const m = h.match(/^#s\/(.+)$/);
  if (m) nav('session', m[1], false);
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
  const needs = live.filter((s) => s.unread > 0 && s.status === 'waiting');
  const stale = sessions.filter((s) => (s.parked || (s.status === 'waiting' && Date.now() - s.last_activity > 48 * 3600e3)) && !needs.includes(s));
  const totalUnread = needs.length; // one KEY message per session (the curated latest ask) — raw out-message counts are noisy
  const playing = S.playScope === 'home' || V.on;
  const playLabel = V.on ? '■ End voice session' : totalUnread ? `▶ Play ${totalUnread} unread` : 'Voice — ask anything';

  const needCards = needs.map((s) => {
    const [bLabel, bColor] = badgeFor(s) || ['REVIEW', '#3fbf5f'];
    const isPlaying = S.playScope === 'home' && S.speakingId === s.last_key?.id;
    const summary = s.question || s.summary || s.last_key?.text || '';
    return `
    <div class="needcard" data-open="${esc(s.id)}">
      <div class="strip" style="background:${bColor}"></div>
      <div class="needrow">
        <span class="badge" style="color:${bColor};border:1px solid ${bColor}66;background:${bColor}14">${bLabel}</span>
        <span class="agchip" style="color:${chipColor(s.tool)};border-color:${chipColor(s.tool)}8c">${esc(AGENT_LABEL[s.tool] || s.tool)}</span>
        <span class="needname">${esc(s.title || s.id)}</span>
        <span style="flex:1"></span>
        ${isPlaying ? '<span class="reading-ind">▶ reading</span>' : ''}
        <span class="needtime">${ago(s.last_activity)}</span>
      </div>
      <div class="needsum">${esc(String(summary).slice(0, 300))}</div>
      <div class="needacts">
        <button class="act listen" data-listen="${esc(s.id)}">${isPlaying ? '■ Stop' : '▶ Listen'}</button>
        <button class="act reply" data-replyto="${esc(s.id)}">● Reply</button>
        <button class="act open" data-open2="${esc(s.id)}">›</button>
      </div>
    </div>`;
  }).join('');

  const sessRow = (s) => `
    <button class="sessrow" data-open="${esc(s.id)}">
      <span class="dot ${s.status === 'working' ? 'pulse' : ''}" style="background:${statusColor(s.status)}"></span>
      <span class="sessname">${esc(s.title || s.id)}</span>
      <span class="sesstask">${esc(s.summary || s.question || '')}</span>
      <span class="sessstatus" style="color:${statusColor(s.status)}">${statusWord(s.status)}</span>
      <span class="sesstime">${ago(s.last_activity)}</span>
    </button>`;
  const rows = live.filter((s) => !needs.includes(s)).map(sessRow).join('');
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
      <button class="playbig ${totalUnread || playing ? '' : 'inert'}" id="play-home">${playLabel}</button>
    </div>
    <div class="scroll home-scroll">
      <div class="sec-label">NEEDS YOU <span class="cnt">${needs.length}</span></div>
      ${needs.length ? needCards : `
        <div class="allclear"><span class="check">✓</span><span class="t">All clear — nothing needs you.</span></div>`}
      ${stale.length ? `<div class="stale-strip">▸ ${stale.length} stale session${stale.length === 1 ? '' : 's'} waiting — no touch from you in days (replying re-heats)</div>` : ''}
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
      ${S.usage?.weekly_pct != null ? `<span class="kv">wk <b>${S.usage.weekly_pct}%</b></span>` : ''}
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
    const cur = V.current ? `${V.current.project || ''} · ${V.current.category || ''} · ${V.current.n}/${V.current.total}` : '';
    return `
    <button class="scrim" data-voice-end aria-label="end"></button>
    <div class="sheet">
      <div class="rec-status">
        <span class="rec-dot" style="${st === 'listening' ? '' : 'background:var(--teal)'}"></span>
        <span>${esc(label)}</span>
      </div>
      ${cur ? `<div class="footnote">${esc(cur)}</div>` : ''}
      ${V.lastHeard ? `<div class="pm-goal" style="text-align:center;color:var(--tx-2)">“${esc(V.lastHeard.slice(0, 160))}”</div>` : ''}
      <div class="wave" style="${st === 'listening' ? '' : 'opacity:.25'}">${[-0.9, -0.7, -0.5, -0.3, -0.6, -0.15, -0.45].map((d, i) => `<span style="height:${[20, 32, 42, 26, 38, 22, 34][i]}px;animation-delay:${d}s"></span>`).join('')}</div>
      <div class="sheetrow">
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

// ---- usage payload → phone shape ------------------------------------------------------------------
function fmtNum(n) {
  n = Number(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
async function loadUsage() {
  try {
    const j = await api(`api/session/${S.sid}/usage`);
    const t = j.usage?.totals || {};
    const cur = j.usage?.model || S.detail?.model;
    const models = (j.usage?.byModel || []).map((m) => ({
      name: m.name,
      current: m.name === cur,
      stats: `${fmtNum(m.token_traffic_tokens)} traffic · ${fmtNum(m.total_tokens)} reported · ${m.events} events · $${Number(m.estimated_cost_usd || 0).toFixed(2)}`,
    }));
    const windows = j.quota?.windows || [];
    const weekly = windows.find((w) => w.name === 'weekly');
    S.usage = {
      modelLabel: (j.quota?.modelLabel || j.usage?.model || '').toUpperCase(),
      traffic: fmtNum(t.token_traffic_tokens),
      reported: fmtNum(t.total_tokens),
      cached: fmtNum(t.cached_input_tokens),
      cost: '$' + Number(t.estimated_cost_usd || 0).toFixed(2),
      footer: `${t.priced_events || 0} priced events · ${(t.events || 0) - (t.priced_events || 0)} inferred · ${t.unpriced_events || 0} unpriced`,
      models,
      weekly_pct: weekly?.usedPercent != null ? Math.round(weekly.usedPercent) : null,
      quota: windows.length ? {
        label: j.quota?.label || '',
        bars: windows.map((w) => ({
          name: w.name,
          pct: w.usedPercent != null ? Math.round(w.usedPercent) : null,
          resets: w.resetAt ? Math.max(1, Math.round((w.resetAt - Date.now()) / 3600e3)) + 'h' : '',
        })),
      } : null,
    };
  } catch { S.usage = { models: [] }; }
  render();
}

// ---- wiring (event delegation after each render) ---------------------------------------------------
function wire() {
  // home
  $('#play-home')?.addEventListener('click', () => {
    if (V.on) return voiceModeEnd('user');
    voiceModeStart(); // interactive conversation: present → listen → confirm → send → next
  });
  // A session tap opens the DESKTOP story view (operator: desktop story is the mobile default for sessions);
  // the phone triage stays the mobile dashboard. ?phone=1 on a session still returns to the phone view.
  for (const el of app.querySelectorAll('[data-open]')) el.addEventListener('click', () => { location.href = 'session?id=' + encodeURIComponent(el.dataset.open); });
  for (const el of app.querySelectorAll('[data-open2]')) el.addEventListener('click', (e) => { e.stopPropagation(); location.href = 'session?id=' + encodeURIComponent(el.dataset.open2); });
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
    nav('session', el.dataset.replyto);
    setTimeout(() => startRec(), 300);
  });

  // session
  $('#go-home')?.addEventListener('click', () => history.back());
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
// #s/<sid> is the phone's own deep link; ?id=<sid> arrives when the desktop session page switches to
// the phone view (the "📱 phone view" pill preserves the URL) — open that session directly.
const bootMatch = location.hash.match(/^#s\/(.+)$/) || (new URLSearchParams(location.search).get('id') ? [null, new URLSearchParams(location.search).get('id')] : null);
if (bootMatch) { S.screen = 'session'; S.sid = bootMatch[1]; S.text = draftGet(S.sid); loadDetail(S.sid); }
history.replaceState({ screen: S.screen, sid: S.sid }, '', location.pathname + (S.screen === 'session' ? `#s/${S.sid}` : '#home'));
loadHome();
render();
