// Story view (design handoff phase 1) — plain-language rendering of the session log, toggled
// against the raw terminal. DOM contract + exact tokens from the handoff's spec.tokens.json;
// verify_story_view.mjs asserts them. Events come from GET api/session/:id/story (src/story.js).
import { api, renderMarkdown } from './common.js';
import { unlockAudio, newPlayback, speakSmart, cycleRate, currentRate } from './tts-player.js';

const GLYPH = { you: '❯', sys: '○', work: '⌕', plan: '☑', note: '·', sub: '⑂', edit: '✎', fail: '✗', check: '✓', ship: '⬆', web: '⌾', report: '≡', ask: '?', stop: '⏹' };
const COLOR = { you: '#58a6ff', sys: '#3a4453', work: '#8a95a5', plan: '#79b8ff', note: '#5c6675', sub: '#9aa7b8', edit: '#d9924e', fail: '#f2554d', check: '#4ecb6c', ship: '#2fd6be', report: '#b9c4d4', ask: '#e2b23e', stop: '#e2b23e' };

let sid = null;
let panelEl = null;
let events = [];
let lastSig = '';
let showFull = false; // instant load shows recent rounds; user can expand to the full story
let rounds = 1; // how many operator rounds are loaded (‹ previous round increments; full ignores it)
let pendingAnchor = null; // feed.scrollHeight before a load-earlier render — keeps the viewport stable while content prepends
let trimmed = false;
let working = false; // live session status — drives the calming "working" animation at the foot
let liveStatus = null; // the CLI's OWN status line while working: {verb, detail, bg} (e.g. Roosting… · 1m 57s · ↓ 6.8k tokens)
let openSteps = new Set(); // indices with the steps expander open
// Client-side memory of asks the operator has already answered here, keyed stably per question. The story
// re-renders wholesale on every SSE 'changed' tick; without this, an answered question bounces back to its
// selection UI on the next refresh because the server story still reports it pending until the transcript
// catches up (operator report: "I chose the option card and it bounced back"). askKey survives re-renders.
const answeredAsks = new Map(); // askKey -> chosen label
function askKey(ev) { return `${ev.ts || 0}|${String(ev.body || ev.title || '').slice(0, 48)}`; }

// "Listen to this report" — playback state lives in MODULE vars (the openSteps/answeredAsks rule:
// render() wipes the DOM wholesale every SSE tick, so buttons re-derive their label from this map;
// the Audio element itself lives in tts-player.js, never in the DOM, so re-renders can't cut audio).
const listenState = new Map(); // evKey -> {phase:'loading'|'playing'|'error', part, total}
let listenActive = null; // {key, handle} — one playback at a time

// Composer echoes — a send appears in the story INSTANTLY (optimistic 'you' bubble) with a read
// lifecycle: '⏳ queued · unread' while it sits in the agent's input queue, '✓ read' once the CLI
// transcript (the story's primary source) contains it — transcript arrival IS the agent consuming
// the message, so the flip is true "the agent has read this", not merely "the server stored it".
// Module state (openSteps rule: survives the wholesale innerHTML re-render every SSE tick).
let sendEchoes = []; // {ts, text, state:'pending'|'read'} — bounded; read ones expire
const readMarks = new Map(); // evKey(server 'you' event) -> true → renders the ✓ read chip
const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// Match a pending echo to an arriving server 'you' event: same text prefix (the server may append
// the attachments note; the spine clips at 800 chars) and not earlier than the send (the consume
// time is AT or AFTER the send — minus 20s of clock slack).
function reconcileEchoes() {
  if (!sendEchoes.length) return false;
  let changed = false;
  for (const e of sendEchoes) {
    if (e.state !== 'pending') continue;
    const n = normText(e.text).slice(0, 60);
    const hit = events.find((ev) => ev.kind === 'you' && (ev.ts || 0) >= e.ts - 20000 && !readMarks.has(evKey(ev))
      && (normText(ev.body || ev.text).startsWith(n) || n.startsWith(normText(ev.body || ev.text).slice(0, 60))));
    if (hit) { e.state = 'read'; readMarks.set(evKey(hit), true); changed = true; }
  }
  const before = sendEchoes.length;
  sendEchoes = sendEchoes.filter((e) => e.state === 'pending' || Date.now() - e.ts < 600000).slice(-20);
  if (readMarks.size > 100) { const k = readMarks.keys().next().value; readMarks.delete(k); } // bound page-life growth
  return changed || sendEchoes.length !== before;
}
// Called by session.js AT the send click (before the POST resolves) — the instant-echo entry
// point. Returns the echo handle so a failed send (409 stopped / error) can cancel the ghost.
export function noteComposerSend(text) {
  if (!sid || !normText(text)) return null; // story not mounted / attachment-only send
  const feed = panelEl && panelEl.querySelector('.story-feed');
  const stick = feed ? nearBottom(feed) : false;
  const echo = { ts: Date.now(), text: String(text), state: 'pending' };
  sendEchoes.push(echo);
  if (sendEchoes.length > 20) sendEchoes = sendEchoes.slice(-20);
  render();
  if (stick) storyToLatest(); // keep them at the tail ONLY if they were already there (scroll rule)
  return echo;
}
export function cancelComposerSend(echo) {
  if (!echo) return;
  sendEchoes = sendEchoes.filter((e) => e !== echo);
  render();
}

// General atom key for the append-MERGE. Requirement: "those messages are already loaded, why clear them
// out?" — a new send must APPEND, never re-window the story down to the newest message. ts is near-unique
// per atom; the body slice disambiguates the rare ts=0 atoms. On refresh, incoming atoms OVERWRITE matching
// keys (so answered/meta updates land) and add new ones; already-loaded atoms with no incoming match are KEPT.
function evKey(e) { return `${e.ts || 0}|${e.kind}|${String(e.body || e.text || e.title || '').slice(0, 48)}`; }

// The scroll position belongs to the USER, not to us. It is preserved across every re-render / refresh /
// story-update / session-switch, and restored (persisted per session) on reopen. We NEVER auto-scroll to
// the latest message — the ONLY thing that jumps to newest is the explicit "Latest" button (storyToLatest).
let feedTop = 0;        // remembered .story-feed scrollTop for the current session
let feedPersistT = 0;   // throttle timer for the per-session persist
const SCROLL_KEY = (id) => `aios_story_scroll_${id}`;
function persistScroll() { try { sessionStorage.setItem(SCROLL_KEY(sid), String(Math.round(feedTop))); } catch {} }
function nearBottom(feed) { return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 8; }
function updateLatestBtn(feed) {
  const btn = panelEl && panelEl.querySelector('[data-story-latest]');
  if (btn && feed) btn.hidden = nearBottom(feed); // show it only when the user is NOT already at the newest
}
function storyToLatest() { // the ONE sanctioned jump-to-newest
  const feed = panelEl && panelEl.querySelector('.story-feed');
  if (!feed) return;
  feed.scrollTop = feed.scrollHeight;
  feedTop = feed.scrollTop;
  persistScroll();
  updateLatestBtn(feed);
}

// Cross-navigation story cache (sessionStorage): a hovered-then-clicked or previously-visited session's
// 1-round story is kept so the NEXT open paints instantly, then refreshes live in the background. Shared
// key with shell.js's hover prefetch. Bounded + default-view only (never the heavy ?full=1 story).
// v2: bumped to flush any story caches polluted by the pre-fix switch race (a session's cache could hold
// another session's atoms; the merge-never-removes design would keep repainting them on reopen).
// v3: rich-report change — old caches hold de-markdowned bodies whose evKeys differ from the new
// markdown-preserving ones; merging both would duplicate every report bubble.
// v4: task-notification turns no longer parse as operator bubbles — cached stories still hold them
// and the merge would resurrect what the parser now drops.
export const STORY_CACHE_KEY = (id) => `aios_story4_${id}`;
const STORY_CACHE_MAX = 220_000; // ~200 KB serialized cap per entry
function readStoryCache(id) { try { const s = sessionStorage.getItem(STORY_CACHE_KEY(id)); return s ? JSON.parse(s) : null; } catch { return null; } }
function writeStoryCache(id, payload) { try { const s = JSON.stringify(payload); if (s.length <= STORY_CACHE_MAX) sessionStorage.setItem(STORY_CACHE_KEY(id), s); } catch {} }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Header rollup: active duration · files touched · worst check · unanswered asks (per README).
function rollup(evs) {
  // r4: "active" = sum of ≤10-min gaps between events (wall-clock age is not activity);
  // snags/checks count only since the operator's last message (this round, not all history).
  let active = 0, prev = 0;
  for (const e of evs) {
    if (!e.ts) continue;
    if (prev && e.ts > prev && e.ts - prev <= 600000) active += e.ts - prev;
    prev = e.ts;
  }
  const mins = Math.round(active / 60000);
  const lastYou = evs.map((e) => e.kind).lastIndexOf('you');
  const recent = evs.slice(lastYou + 1);
  const files = new Set();
  for (const e of recent) if (e.kind === 'edit') for (const c of e.chips || []) files.add(String(c).split(' ')[0]);
  const fails = recent.filter((e) => e.kind === 'fail').length;
  const checks = recent.filter((e) => e.kind === 'check').length;
  const asks = evs.filter((e) => e.kind === 'ask' && !e.answered);
  const parts = [];
  if (mins) parts.push(mins >= 90 ? `${Math.round(mins / 6) / 10} hr active` : `${mins} min active`);
  if (files.size) parts.push(`${files.size} file${files.size > 1 ? 's' : ''} touched this round`);
  if (fails) parts.push(`${fails} snag${fails > 1 ? 's' : ''} this round`);
  else if (checks) parts.push('checks green');
  if (asks.length) parts.push(`${asks.length} question${asks.length > 1 ? 's' : ''} for you`);
  return parts.join(' · ') || (mins ? `${mins} min active · working` : 'session starting');
}

function stepsBodyHtml(steps) {
  return `<div class="story-steps" data-story-steps>${steps.map((st) => `
      <div class="story-step">${esc(st.human || '')}</div>
      ${st.cmd ? `<div class="story-cmd">$ ${esc(String(st.cmd).slice(0, 200))}</div>` : ''}`).join('')}</div>`;
}
function stepsHtml(ev, i) {
  const steps = ev.steps || [];
  if (!steps.length) return '';
  const open = openSteps.has(i);
  return `
    <div class="story-steps-toggle${open ? ' open' : ''}" data-story-steps-toggle data-i="${i}">${open ? '▾' : '▸'} ${steps.length > 1 ? steps.length + ' steps' : 'show the command'}</div>
    ${open ? stepsBodyHtml(steps) : ''}`;
}

// S8: the agent-recommended / affirmative option is primary; else the first.
export function primaryIndex(opts) {
  let i = opts.findIndex((o) => /recommend/i.test(`${o.label || ''} ${o.spoken || ''}`));
  if (i < 0) i = opts.findIndex((o) => /^y(es)?$/i.test(String(o.key || '')) || /^yes\b/i.test(String(o.label || '')));
  return i < 0 ? 0 : i;
}

function askHtml(ev) {
  const opts = ev.options || [];
  const local = answeredAsks.get(askKey(ev));
  if (ev.answered || local != null) {
    const w = ev.answeredWith || local || '';
    return `<div class="story-answered">✓ answered${w ? ` "${esc(w)}"` : ''} — session resumed</div>`;
  }
  if (!opts.length) return '';
  const pi = primaryIndex(opts);
  const ak = esc(askKey(ev));
  return `<div class="story-ask-opts">${opts.map((o, j) => `
    <button class="story-ask-opt${j === pi ? ' primary' : ''}" data-story-ask-opt data-askkey="${ak}" data-label="${esc(o.label || o.spoken || o.key || '')}" data-key="${esc(o.key ?? o.label ?? '')}">${esc(o.key ? o.key + ' — ' : '')}${esc(o.label || o.spoken || '')}</button>`).join('')}</div>`;
}

function listenLabel(st, idleLabel) {
  if (!st) return idleLabel;
  if (st.phase === 'loading') return '… preparing';
  if (st.phase === 'playing') return st.total > 1 ? `⏹ stop · ${st.part}/${st.total}` : '⏹ stop';
  if (st.phase === 'error') return '⚠ retry';
  return idleLabel;
}
// The listen controls on reports long enough to be worth hearing: ▶ listen (full polished report),
// ▶ quick (a ~30s digest, only on long sources), and a live speech-rate chip while playing.
// Labels re-derive from listenState on every wholesale re-render; between renders paintListen()
// repaints the row in place. Clicks are DELEGATED on panelEl (initStoryView), so repaints and
// re-renders never need handler rebinding.
function listenRowInner(key, srcLen) {
  const st = listenState.get(key); // {phase, part, total, level}
  const btn = (level, idleLabel, title) => {
    const on = st && st.level === level;
    return `<button class="story-listen${on ? ' ' + st.phase : ''}" data-story-listen data-evkey="${esc(key)}" data-level="${level}" title="${title}">${on ? listenLabel(st, idleLabel) : idleLabel}</button>`;
  };
  let html = btn('full', '▶ listen', 'Listen to this report');
  if (srcLen > 2000) html += btn('brief', '▶ quick', 'Quick ~30-second version');
  if (st && st.phase === 'playing') html += `<button class="story-listen rate" data-story-listen-rate title="Speech speed">${currentRate()}×</button>`;
  return html;
}
function listenRowHtml(ev) {
  if (ev.kind !== 'report') return '';
  const text = String(ev.body || ev.text || '');
  if (text.length <= 200) return '';
  const key = evKey(ev);
  return `<div class="story-listen-row" data-story-listen-row data-evkey="${esc(key)}" data-srclen="${text.length}">${listenRowInner(key, text.length)}</div>`;
}
function paintListen(key) {
  const row = panelEl && panelEl.querySelector(`[data-story-listen-row][data-evkey="${CSS.escape(key)}"]`);
  if (!row) return; // scrolled/windowed out of the DOM — the state map still drives the next render
  row.innerHTML = listenRowInner(key, Number(row.dataset.srclen) || 0);
}
function setListen(key, st) { listenState.set(key, st); paintListen(key); }
function clearListen(key) { listenState.delete(key); paintListen(key); }
function stopListen() {
  if (!listenActive) return;
  const { key, handle } = listenActive;
  listenActive = null;
  try { handle.stop(); } catch {}
  clearListen(key);
}
async function onListenTap(key, level = 'full') {
  if (listenActive && listenActive.key === key && listenActive.level === level) return stopListen(); // tap while playing = stop
  stopListen(); // one playback at a time — a new tap silences the previous one
  const ev = events.find((e) => evKey(e) === key);
  const text = String(ev?.body || ev?.text || ''); // captured NOW — survives later window trims
  if (!text) return;
  unlockAudio(); // synchronously inside the tap gesture (iOS) — before any await
  const handle = newPlayback();
  listenActive = { key, handle, level };
  setListen(key, { phase: 'loading', level });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(`api/session/${sid}/voice-report`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, ts: ev.ts || 0, level }), signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!r.ok) throw new Error('voice-report ' + r.status);
    const vr = await r.json();
    const parts = Array.isArray(vr.parts) && vr.parts.length && vr.parts[0] ? vr.parts : [text.slice(0, 900)];
    for (let i = 0; i < parts.length; i++) {
      if (handle.stopped) break;
      setListen(key, { phase: 'playing', part: i + 1, total: parts.length, level });
      await speakSmart(parts[i], handle, { ttsExtra: vr.tts || {} });
    }
    clearListen(key);
  } catch {
    if (handle.stopped) clearListen(key);
    else { setListen(key, { phase: 'error', level }); setTimeout(() => { if (listenState.get(key)?.phase === 'error') clearListen(key); }, 2400); }
  } finally {
    if (listenActive && listenActive.key === key && listenActive.handle === handle) listenActive = null;
  }
}

function eventHtml(ev, i) {
  if (ev.kind === 'gap') {
    const mins = Math.max(1, Math.round((ev.durationMs || 0) / 60000));
    const fallback = ev.durationMs ? `quiet for ${mins >= 60 ? Math.round(mins / 6) / 10 + ' hr' : mins + ' min'}` : 'quiet stretch';
    return `<div class="story-gap" data-story-ev data-kind="gap"><span>${esc(ev.title || fallback)}</span></div>`;
  }
  const color = COLOR[ev.kind] || '#8a95a5';
  const isAsk = ev.kind === 'ask';
  const untitled = ['you', 'sys', 'note'].includes(ev.kind);
  const metaCls = /recovered/.test(ev.meta || '') ? ' ok' : (isAsk && !ev.answered ? ' warn' : '');
  // ev.text is the fallback-story field (aios event log: "Session launched", "operator message · N chars…")
  // — render it as the body too, else untitled you/sys fallback events showed as bare icon+timestamp rows.
  // report/note bodies are the agent's own writing and render as MARKDOWN (tables/headings/code —
  // renderMarkdown escapes first, so this stays XSS-safe); everything else stays escaped plain text.
  const bodyText = ev.body || ev.text || '';
  const rich = ev.kind === 'report' || ev.kind === 'note';
  // Attachment previews render INSIDE the operator's bubble — one send, one bubble (operator: the
  // image "should be previewed in the story view with the user request"). Basenames come from the
  // parser; the attachment route serves only this session's own upload dir.
  const imgsHtml = (ev.images || []).length
    ? `<div class="story-imgs">${ev.images.map((f) => `<img class="story-shot" data-story-shot loading="lazy" src="api/session/${sid}/attachment/${encodeURIComponent(f)}" alt="${esc(f)}" title="${esc(f)}" />`).join('')}</div>`
    : '';
  const body = (bodyText || imgsHtml) ? (rich
    ? `<div class="story-body md">${renderMarkdown(bodyText)}${imgsHtml}</div>`
    : `<div class="story-body">${esc(bodyText)}${imgsHtml}</div>`) : '';
  // S3: one baseline row — title · meta · time (time right-aligned); untitled events keep the
  // time in the block's top-right corner instead.
  const head = untitled
    ? `<span class="story-ts corner">${fmtClock(ev.ts)}</span>`
    : `<div class="story-title-row" data-story-title-row>
        <span class="story-title">${esc(ev.title || ev.kind)}</span>
        ${ev.meta ? `<span class="story-meta${metaCls}">${esc(ev.meta)}</span>` : ''}
        <span class="story-ts">${fmtClock(ev.ts)}</span>
      </div>`;
  // Send-state chip on the operator's own messages from THIS page view: pending echo → unread/queued,
  // reconciled transcript event → ✓ read. Historical bubbles (no local echo) stay chip-free.
  const sendState = ev.kind !== 'you' ? null : (ev._echo ? 'pending' : (readMarks.has(evKey(ev)) ? 'read' : null));
  const stateChip = sendState
    ? `<span class="story-sendstate ${sendState}" data-story-sendstate="${sendState}">${sendState === 'pending' ? (working ? '⏳ queued · unread' : '⏳ delivering…') : '✓ read'}</span>`
    : '';
  const inner = `
    ${head}
    ${body}
    ${stateChip}
    ${listenRowHtml(ev)}
    ${(ev.chips || []).length ? `<div class="story-chips">${ev.chips.map((c) => `<span class="story-chip">${esc(c)}</span>`).join('')}</div>` : ''}
    ${ev.shot ? `<div class="story-shot-wrap"><img class="story-shot" data-story-shot src="${esc(ev.shot)}" alt="screenshot" loading="lazy" /><span class="story-shot-cap">screenshot.png · click to enlarge</span></div>` : ''}
    ${stepsHtml(ev, i)}
    ${isAsk ? askHtml(ev) : ''}`;
  return `
    <div class="story-ev${ev.indent ? ' sub-indent' : ''}" data-story-ev="${ev.kind}" data-kind="${ev.kind}">
      <div class="story-icon" style="color:${color};border-color:${color}44;background:${color}14">${GLYPH[ev.kind] || '·'}</div>
      <div class="story-main">
        ${isAsk ? `<div class="story-card">${inner}</div>` : inner}
      </div>
    </div>`;
}

// The calming foot-of-story working indicator. When the CLI exposes its own live status line (claude
// "Roosting… (1m 57s · ↓ 6.8k tokens)", codex "Working (10s) · 5 background terminals running") show THAT,
// styled to the story: gerund in sans, the elapsed/tokens detail as a mono chip, background count as a chip.
function renderWorking() {
  if (!working) return '';
  const dots = '<span class="story-working-dots"><i></i><i></i><i></i></span>';
  const ls = liveStatus;
  if (!ls) return `<div class="story-working" data-story-working>${dots}<span class="story-working-verb">the agent is working…</span></div>`;
  const detail = ls.detail ? `<span class="story-working-detail">${esc(ls.detail)}</span>` : '';
  const bg = ls.bg ? `<span class="story-working-bg">${esc(ls.bg)}</span>` : '';
  return `<div class="story-working" data-story-working>${dots}<span class="story-working-verb">${esc(ls.verb)}</span>${detail}${bg}</div>`;
}

// The rendered feed = server events + still-pending composer echoes (as 'you' bubbles at their send
// time — echoes are newest, so this rarely reorders anything). Read echoes vanish: the real
// transcript event replaced them and carries the ✓ read chip via readMarks.
function feedList() {
  const pend = sendEchoes.filter((e) => e.state === 'pending').map((e) => ({ kind: 'you', ts: e.ts, body: e.text, _echo: true }));
  return pend.length ? [...events, ...pend].sort((a, b) => (a.ts || 0) - (b.ts || 0)) : events;
}

function render() {
  if (!panelEl) return;
  panelEl.innerHTML = `
    <div class="story-head">
      <span class="story-head-title">What happened, in plain language</span>
      <span class="story-rollup" data-story-rollup>${esc(rollup(events))}</span>
    </div>
    <div class="story-feed">${trimmed && !showFull ? '<div class="story-loadbar"><button class="story-earlier" data-story-prev title="Load one more round of conversation">‹ previous round</button><button class="story-earlier" data-story-earlier>↑ show the full story</button></div>' : ''}${feedList().map(eventHtml).join('') || '<div class="story-empty">Nothing to tell yet — the story appears as the agent works.</div>'}</div>
    <button class="story-latest-btn" data-story-latest hidden>↓ Latest</button>
    ${renderWorking()}`;
  wire();
  const feed = panelEl.querySelector('.story-feed');
  if (feed) {
    // PRESERVE the user's position across this wholesale re-render (the .story-feed node is recreated by the
    // innerHTML wipe above, so its scrollTop reset to 0 — restore it). Never jump to the bottom automatically.
    // A load-earlier render PREPENDS content: shift the restore by the height delta so the reading
    // position stays put instead of jumping to (now much earlier) absolute offset.
    if (pendingAnchor != null) { feedTop = Math.max(0, feedTop + (feed.scrollHeight - pendingAnchor)); pendingAnchor = null; persistScroll(); }
    feed.scrollTop = feedTop;
    feed.addEventListener('scroll', () => {
      feedTop = feed.scrollTop;
      clearTimeout(feedPersistT); feedPersistT = setTimeout(persistScroll, 300);
      updateLatestBtn(feed);
    }, { passive: true });
    updateLatestBtn(feed);
  }
}

function wire() {
  const latest = panelEl.querySelector('[data-story-latest]');
  if (latest) latest.onclick = storyToLatest; // the only path that scrolls to the newest message
  // Both load-earlier paths anchor the viewport: content PREPENDS, so the scroll position is adjusted
  // by the height delta after the re-render (otherwise what you were reading jumps off-screen).
  const anchor = () => { const f = panelEl.querySelector('.story-feed'); pendingAnchor = f ? f.scrollHeight : null; };
  const earlier = panelEl.querySelector('[data-story-earlier]');
  if (earlier) earlier.onclick = () => { showFull = true; lastSig = ''; anchor(); refreshStory({ quiet: false }); };
  const prev = panelEl.querySelector('[data-story-prev]');
  if (prev) prev.onclick = () => { rounds = Math.min(20, rounds + 1); lastSig = ''; anchor(); refreshStory({ quiet: false }); };
  for (const t of panelEl.querySelectorAll('[data-story-steps-toggle]')) {
    t.onclick = () => {
      // toggle IN PLACE — a full re-render would detach the element mid-interaction (verifier
      // holds the handle across open/close, and a user double-click would misfire too)
      // per-block, independent (spec): toggle ONLY this cluster, in place
      const i = Number(t.dataset.i);
      const open = openSteps.has(i);
      if (open) {
        openSteps.delete(i);
        if (t.nextElementSibling?.matches('[data-story-steps]')) t.nextElementSibling.remove();
        t.classList.remove('open');
        t.textContent = `▸ ${t.textContent.replace(/^[▸▾]\s*/, '')}`;
      } else {
        openSteps.add(i);
        t.insertAdjacentHTML('afterend', stepsBodyHtml(events[i]?.steps || []));
        t.classList.add('open');
        t.textContent = `▾ ${t.textContent.replace(/^[▸▾]\s*/, '')}`;
      }
    };
  }
  for (const b of panelEl.querySelectorAll('[data-story-ask-opt]')) {
    b.onclick = async () => {
      const key = b.dataset.key || b.textContent.trim();
      const label = b.dataset.label || key;
      try {
        await api(`api/session/${sid}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: key, source: 'text' }) });
        if (b.dataset.askkey) answeredAsks.set(b.dataset.askkey, label); // sticky: survives the next SSE re-render
        b.closest('.story-ask-opts')?.replaceWith(Object.assign(document.createElement('div'), { className: 'story-answered', textContent: `✓ answered "${label}" — session resumed` }));
      } catch (e) { b.textContent = '⚠ ' + (e.message || e); }
    };
  }
  for (const img of panelEl.querySelectorAll('[data-story-shot]')) {
    img.onclick = () => {
      const lb = document.createElement('div');
      lb.className = 'story-lightbox';
      lb.innerHTML = `<img src="${img.src}" alt="screenshot" />`;
      lb.onclick = () => lb.remove();
      const esc2 = (e) => { if (e.key === 'Escape') { lb.remove(); document.removeEventListener('keydown', esc2); } };
      document.addEventListener('keydown', esc2);
      document.body.appendChild(lb);
    };
  }
}

export async function refreshStory({ quiet = true } = {}) {
  const mySid = sid; // capture: a session switch DURING this await must not apply session A's story to B
  try {
    const r = await api(`api/session/${mySid}/story${showFull ? '?full=1' : rounds > 1 ? `?rounds=${rounds}` : ''}`);
    // A fast session switch (switchSession) re-points `sid` + resets `events` while this fetch was in
    // flight. Applying this now-stale response would leak session A's atoms into session B's feed AND
    // write them to B's cache (operator report: a share/bb2 story rendered under the aios session's
    // header, 2026-07-13). Discard it — B's own refreshStory already ran with the correct id.
    if (sid !== mySid) return;
    const incoming = r.events || [];
    if (!events.length) {
      events = incoming; // first open of this session: adopt the windowed story loaded from source
    } else if (incoming.length) {
      // MERGE, don't replace: keep every already-loaded atom, let incoming overwrite matching keys (so
      // answered/meta updates land) and append genuinely new ones. A new send appends — the server's
      // 1-round window no longer clears the history the user already had loaded.
      const byKey = new Map(events.map((e) => [evKey(e), e]));
      for (const e of incoming) byKey.set(evKey(e), e);
      events = [...byKey.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
    }
    trimmed = !!(r.meta && r.meta.trimmed) && !showFull;
    working = r.status === 'working';
    liveStatus = r.liveStatus || null;
    reconcileEchoes(); // pending sends whose transcript event just arrived flip to ✓ read
    // re-render when anything user-visible changes: count, answers landing, a cluster/fail meta update
    // on the last events (count alone left stale ✓/recovered states), the live status line changing,
    // or a composer echo's unread→read state moving.
    const lsSig = working ? (liveStatus ? `${liveStatus.verb}|${liveStatus.detail}|${liveStatus.bg || ''}` : 'w') : '';
    const sig = events.length + ':' + events.reduce((a, e) => a + (e.answered ? 1 : 0), 0)
      + ':' + events.slice(-3).map((e) => e.meta || '').join('|') + ':' + lsSig
      + ':' + sendEchoes.map((e) => e.state === 'pending' ? 'p' : 'r').join('') + readMarks.size;
    if (sig !== lastSig) { lastSig = sig; render(); }
    if (!showFull) writeStoryCache(mySid, { events, trimmed, working, liveStatus }); // warm THIS session's cache
  } catch (e) {
    if (sid === mySid && !quiet && panelEl) panelEl.innerHTML = `<div class="story-empty">story unavailable: ${esc(e.message || e)}</div>`;
  }
}

export function initStoryView({ sessionId, panel }) {
  const switching = sid !== sessionId;
  sid = sessionId;
  panelEl = panel;
  // Listen controls use ONE delegated handler on the persistent panel (attached once per panel
  // element): in-place row repaints and wholesale re-renders never need onclick rebinding, and
  // unlockAudio still runs synchronously inside the tap gesture via onListenTap.
  if (panel && !panel._listenWired) {
    panel._listenWired = true;
    panel.addEventListener('click', (e) => {
      const rate = e.target.closest('[data-story-listen-rate]');
      if (rate) {
        cycleRate(); // applies live to the playing audio; persists (shared with voice mode)
        const key = rate.closest('[data-story-listen-row]')?.dataset.evkey;
        if (key) paintListen(key);
        return;
      }
      const b = e.target.closest('[data-story-listen]');
      if (b) onListenTap(b.dataset.evkey, b.dataset.level || 'full');
    });
  }
  // A new session is a fresh story — reset accumulated state so session A's atoms never bleed into B.
  // Switching also STOPS any playing voice report (session A's audio must not narrate session B).
  if (switching) { stopListen(); listenState.clear(); sendEchoes = []; readMarks.clear(); events = []; answeredAsks.clear(); openSteps.clear(); showFull = false; rounds = 1; pendingAnchor = null; lastSig = ''; }
  // Restore THIS session's last scroll position (survives refresh + reopen); 0 = top of the loaded story
  // (its last user message), never auto-scrolled to the newest.
  feedTop = Number(sessionStorage.getItem(SCROLL_KEY(sid))) || 0;
  // Instant first paint from the cross-nav cache (hover-prefetched or last-visited), then refresh live.
  if (!showFull) {
    const cached = readStoryCache(sid);
    if (cached && Array.isArray(cached.events) && cached.events.length) {
      events = cached.events; trimmed = !!cached.trimmed; working = !!cached.working; liveStatus = cached.liveStatus || null;
      lastSig = ''; render();
    }
  }
  refreshStory({ quiet: false });
}
