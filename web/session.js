import { $, api, coalesce, escapeHtml, wireMic, registerSW, isInteracting, setSessionBrowserIdentity, renderMarkdown } from './common.js';
import { initAgentPanel } from './agents/host.js';

registerSW();
const params = new URLSearchParams(location.search);
const id = params.get('id');
if (!id) location.href = document.baseURI;
const resizeOff = params.get('resize') === 'off' || params.has('noresize');

// ---- split layout -----------------------------------------------------------
const shell = $('#session-shell');
const rail = $('#session-rail');

const usageResizer = $('#usage-resizer');
const PREF_RAIL_PINNED = 'aios.session.railPinned';
const PREF_USAGE_WIDTH = 'aios.session.usagePanelWidth';
const PREF_SIDE_TAB = 'aios.session.sideTab';
const PREF_MAIN_VIEW = 'aios.session.mainView';
const PREF_MAP_GENERATE_TARGET = 'aios.session.mapGenerateTarget';
const PREF_MAP_UPDATE_TARGET = 'aios.session.mapUpdateTarget';
const RESIZE_CLIENT_KEY = 'aios.session.resizeClientId';
const RESIZE_INTERACTIVE_WINDOW_MS = 30000;
const PREF_USAGE_FRACTION = 'aios.session.usagePanelFraction';
const RAIL_PINNED_W = 280; // keep in sync with --session-rail-width
// The usage/main split is stored as a FRACTION of the available width (innerWidth minus the pinned
// rail), so it scales across screen sizes and shifts proportionally when the rail is pinned/unpinned.
let usagePanelFraction = (() => {
  const f = Number(localStorage.getItem(PREF_USAGE_FRACTION));
  if (Number.isFinite(f) && f > 0) return f;
  const oldPx = Number(localStorage.getItem(PREF_USAGE_WIDTH)); // migrate legacy px preference
  if (Number.isFinite(oldPx) && oldPx > 0) return Math.min(0.85, Math.max(0.2, oldPx / Math.max(640, window.innerWidth)));
  return 0.5;
})();

function randomClientId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sessionClientId() {
  try {
    let v = sessionStorage.getItem(RESIZE_CLIENT_KEY);
    if (!v) {
      v = randomClientId();
      sessionStorage.setItem(RESIZE_CLIENT_KEY, v);
    }
    return v;
  } catch {
    return randomClientId();
  }
}
const resizeClientId = sessionClientId();

function automatedResizeClient() {
  return resizeOff || navigator.webdriver === true || /\bHeadlessChrome\//.test(navigator.userAgent || '');
}

function syncHeaderHeight() {
  const h = Math.ceil(document.querySelector('header')?.getBoundingClientRect().height || 52);
  document.documentElement.style.setProperty('--session-header-h', `${h}px`);
}
syncHeaderHeight();
if ('ResizeObserver' in window) {
  const headerObserver = new ResizeObserver(syncHeaderHeight);
  headerObserver.observe(document.querySelector('header'));
}

function railWidth() {
  return shell.classList.contains('rail-pinned') ? RAIL_PINNED_W : shell.classList.contains('rail-mini') ? 56 : 0;
}
function availableWidth() {
  return Math.max(640, window.innerWidth - railWidth());
}
// Clamp the fraction so neither pane becomes unusable (usage >= 320px, main >= 420px).
function clampFraction(f) {
  const avail = availableWidth();
  const minF = Math.min(0.8, 320 / avail);
  const maxF = Math.max(minF, 1 - 420 / avail);
  return Math.max(minF, Math.min(maxF, Number.isFinite(f) ? f : 0.5));
}
function applyUsageWidth({ save = false } = {}) {
  usagePanelFraction = clampFraction(usagePanelFraction);
  const px = Math.round(usagePanelFraction * availableWidth());
  shell.style.setProperty('--usage-panel-width', `${px}px`);
  if (save) localStorage.setItem(PREF_USAGE_FRACTION, String(Number(usagePanelFraction.toFixed(4))));
  setTimeout(syncSize, 80);
}
function setRailPinned(pinned, { save = true } = {}) {
  shell.classList.toggle('rail-pinned', pinned);
  rail.classList.toggle('pinned', pinned);
  if (save) localStorage.setItem(PREF_RAIL_PINNED, pinned ? '1' : '0');
  applyUsageWidth(); // re-derive px from the fraction for the new available width (both panes shift)
}
// R2 T1/T2: the sidebar is DOCKED on every session entry (the pin model is superseded); collapse
// lasts only within the current page visit — a fresh navigation always restores the docked rail.
setRailPinned(true, { save: false });
applyUsageWidth();

// ---- 56px mini-rail + peek (design handoff session-view collapse model) ---------------------------
// docked (rail-pinned) ⇄ mini (rail-mini): ⟨ collapse / ⌘\ toggles; the mini rail's ≡ PEEKS the full
// sidebar as a fixed overlay (no terminal reflow); state persists until docked again.
const PREF_RAIL_MODE = 'aios.session.railMode';
function setRailMini(mini) {
  shell.classList.toggle('rail-mini', mini);
  document.querySelector('[data-rail-mini]').hidden = !mini;
  rail.classList.toggle('mini', mini);
  if (mini) setRailPinned(false, { save: false });
  else { rail.classList.remove('peek'); setRailPinned(true, { save: false }); }
  const rc = document.getElementById('rail-collapse');
  if (rc) rc.textContent = mini ? 'dock' : '⟨ collapse';
  renderMiniDots();
  applyUsageWidth();
}
function renderMiniDots() {
  const box = document.getElementById('mini-dots');
  if (!box || !shell.classList.contains('rail-mini')) return;
  const rows = [...document.querySelectorAll('#session-rail-list a[href*="session?id="]')].slice(0, 8);
  box.innerHTML = rows.map((a) => {
    const active = a.href.includes(id);
    const working = /working/i.test(a.textContent);
    return `<a class="mini-dot${active ? ' me' : ''}" href="${a.getAttribute('href')}" title="${(a.textContent || '').trim().slice(0, 60).replace(/"/g, '')}"><i class="dk-dot ${working ? 'ok' : 'warn'}"></i></a>`;
  }).join('');
}
document.getElementById('rail-collapse').onclick = () => setRailMini(!shell.classList.contains('rail-mini'));
document.getElementById('mini-peek').onclick = () => {
  // peek: overlay the full rail, fixed — zero reflow; leaves on mouseout or dock
  rail.classList.add('peek');
  const close = (e) => { if (!rail.contains(e.relatedTarget)) { rail.classList.remove('peek'); rail.removeEventListener('mouseleave', close); } };
  rail.addEventListener('mouseleave', close);
};
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); setRailMini(!shell.classList.contains('rail-mini')); }
});
setInterval(renderMiniDots, 5000); // dots follow the live rail list (collapse is never restored across navigations — R2 T1)

let resizeDrag = null;
usageResizer.addEventListener('pointerdown', (e) => {
  if (matchMedia('(max-width: 1050px)').matches) return;
  resizeDrag = { x: e.clientX, startPx: usagePanelFraction * availableWidth() };
  usageResizer.setPointerCapture(e.pointerId);
  shell.classList.add('resizing');
  document.body.style.userSelect = 'none';
});
usageResizer.addEventListener('pointermove', (e) => {
  if (!resizeDrag) return;
  usagePanelFraction = (resizeDrag.startPx - (e.clientX - resizeDrag.x)) / availableWidth();
  applyUsageWidth();
});
function finishResize(e) {
  if (!resizeDrag) return;
  applyUsageWidth({ save: true });
  resizeDrag = null;
  shell.classList.remove('resizing');
  document.body.style.userSelect = '';
  if (e?.pointerId != null) {
    try {
      usageResizer.releasePointerCapture(e.pointerId);
    } catch {}
  }
}
usageResizer.addEventListener('pointerup', finishResize);
usageResizer.addEventListener('pointercancel', finishResize);
addEventListener('resize', () => {
  syncHeaderHeight();
  applyUsageWidth();
});

function renderSessionRail(sessions = []) {
  const live = sessions
    .filter((s) => s.status !== 'exited')
    .sort((a, b) => (a.id === id ? -1 : b.id === id ? 1 : Number(b.last_activity || 0) - Number(a.last_activity || 0)));
  $('#session-rail-list').innerHTML = live.length
    ? live.map((s) => {
        const project = s.project?.name || '(adhoc)';
        const meta = [s.modelLabel || s.model, s.fastMode ? 'fast' : null, s.effort, s.autonomy, s.status].filter(Boolean).join(' · ');
        return `
          <a class="rail-session ${s.id === id ? 'active' : ''}" href="session?id=${encodeURIComponent(s.id)}" title="${escapeHtml(project + ' · ' + (s.title || ''))}">
            <span class="dot ${escapeHtml(s.status || '')}"></span>
            <span class="rail-session-body">
              <span class="rail-session-title"><b>${escapeHtml(project)}</b><span class="badge" style="border-color:${escapeHtml(s.toolColor || '#30363d')}99;color:${escapeHtml(s.toolColor || '#8b949e')}">${escapeHtml(s.toolLabel || s.tool || '')}</span></span>
              <span class="rail-session-task">${escapeHtml(s.title || '(interactive)')}</span>
              <span class="rail-session-meta">${escapeHtml(meta)}</span>
            </span>
          </a>`;
      }).join('')
    : '<div class="rail-empty">No active sessions</div>';
}
async function loadSessionRail() {
  try {
    const st = await api('api/state');
    renderSessionRail(st.sessions || []);
  } catch {}
}
loadSessionRail();

// ---- right panel: the agent host owns the tab bar + panels (web/agents/host.js) ------------
// Built lazily near the SSE wiring (after loadMap/loadUsage + their state exist), since the host
// drives the Map/Usage "legacy" panels through those loaders.
let agentPanel = null;

// ---- terminal ---------------------------------------------------------------
const term = new Terminal({
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff' },
  scrollback: 8000,
  cursorBlink: false,
  // Cursor is hidden while the terminal is unfocused (calm idle viewing) and shows as a block only
  // while it's focused (i.e. while you're typing into it).
  cursorInactiveStyle: 'none',
  // We forward keystrokes ourselves (see below) so the helper <textarea> can stay READ-ONLY — a
  // read-only field is the only thing that reliably stops macOS iCloud Passwords / browser autofill
  // from ever popping up over the terminal (autocomplete=off alone is ignored by Safari/iCloud).
  disableStdin: true,
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
const termEl = $('#term');
term.open(termEl);
// Make xterm's hidden helper <textarea> inert so NO browser/OS autofill (iCloud Passwords, 1Password,
// …) can attach to it: read-only fields are never offered autofill, in Chrome and Safari alike. xterm
// still focuses it on click (selection/copy + the focused cursor keep working); we capture keystrokes
// via keydown below and forward them to the live pane, which keeps the terminal interactive.
const termTextarea = term.textarea;
if (termTextarea) {
  termTextarea.readOnly = true;
  termTextarea.tabIndex = -1;
  termTextarea.setAttribute('aria-hidden', 'true');
  termTextarea.setAttribute('autocomplete', 'off');
  termTextarea.setAttribute('autocorrect', 'off');
  termTextarea.setAttribute('autocapitalize', 'off');
  termTextarea.setAttribute('spellcheck', 'false');
  termTextarea.setAttribute('inputmode', 'none');
  termTextarea.setAttribute('data-1p-ignore', 'true');
  termTextarea.setAttribute('data-lpignore', 'true');
  termTextarea.setAttribute('data-form-type', 'other');
}

// Copy de-wrap: the claude/codex TUIs HARD-wrap long prose to the pane width (with indented continuation
// lines), so a naive copy yields a paragraph chopped into ~width-sized chunks. On copy from the terminal we
// rejoin soft-wrap continuations — a line is joined to the previous one only when the previous line FILLED the
// pane width (a real wrap) and this line isn't the start of a new block (blank line, bullet, box-drawing,
// heading, checkbox, prompt marker). Intentional breaks, lists, and code indentation are preserved.
function dewrapTerminalText(text, wrapCols) {
  const raw = String(text || '').split('\n');
  if (raw.length < 2) return text;
  const lens = raw.map((l) => l.replace(/\s+$/, '').length);
  // The wrap column is the widest REAL content line — the column the TUI actually wrapped prose at, which
  // is often a bit less than the grid width (Claude keeps side margins). Cap it at the grid width (term.cols)
  // so a leftover over-wide rule can't inflate the estimate; the old plain-max() guess broke on exactly that.
  const cap = Number(wrapCols) >= 24 ? Number(wrapCols) : Infinity;
  let wrapW = 24;
  for (const n of lens) if (n <= cap && n > wrapW) wrapW = n;
  // Greedy word-wrap leaves a ragged right edge (a line can end a whole word short of the column), so a
  // continuation is any predecessor within ~a word of the wrap width, not flush against it (the old -4 was
  // far too tight and left mid-paragraph breaks). Blank lines and block markers still force a real break.
  const margin = Math.min(16, Math.max(6, Math.round(wrapW * 0.1)));
  const isBlock = (s) => /^\s*([❯>│╭╮╰╯├└┌┐┃━─┄┈┊╎]|[●○◉◯⦿⎿⏺]|[-*+•‣▸▹·]\s|\d+[.)]\s|#{1,6}\s|\[[ xX]\])/.test(s);
  const out = [];
  let prevFilled = false;
  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i];
    if (prevFilled && out.length && cur.trim() && !isBlock(cur)) {
      out[out.length - 1] = out[out.length - 1].replace(/\s+$/, '') + ' ' + cur.replace(/^\s+/, '');
    } else {
      out.push(cur);
    }
    prevFilled = lens[i] >= wrapW - margin; // did THIS source line fill the width? -> next line is a continuation
  }
  return out.join('\n');
}
// Intercept copy from the terminal and substitute the de-wrapped text (only when there's a terminal selection).
termEl.addEventListener('copy', (e) => {
  let sel = '';
  try { sel = term.getSelection(); } catch {}
  if (!sel || !e.clipboardData) return; // nothing selected here -> let the browser copy normally
  const fixed = dewrapTerminalText(sel, term.cols);
  if (fixed === sel) return; // nothing to rejoin -> don't interfere
  try { e.clipboardData.setData('text/plain', fixed); e.preventDefault(); } catch {}
});

// Interactive terminal: forward keystrokes to the live pane ourselves. Because the textarea is
// read-only (autofill-proof), xterm's own onData can't fire, so we translate keydown -> the bytes a
// real terminal sends and POST them to /type (tmux send-keys -l). Buffered ~16ms so fast typing
// coalesces into fewer round-trips. Cmd/Option combos are left to the browser (copy/paste/shortcuts).
let typeBuf = '';
let typeTimer = null;
function flushType() {
  typeTimer = null;
  const data = typeBuf;
  typeBuf = '';
  if (!data) return;
  fetch(`api/session/${id}/type`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
  }).catch(() => {}); // 409 (pane gone) -> the composer Send path already offers Resume
}
function sendToPane(data) {
  typeBuf += data;
  if (!typeTimer) typeTimer = setTimeout(flushType, 16);
}
// Translate a keydown into the byte sequence a real terminal would send, or null to let the browser
// handle it (Cmd/Option shortcuts, copy/paste, function keys).
function keyToPaneBytes(e) {
  if (e.metaKey || e.altKey) return null;
  if (e.ctrlKey) {
    const c = e.key.toLowerCase();
    if (c.length === 1 && c >= 'a' && c <= 'z') return String.fromCharCode(c.charCodeAt(0) - 96); // ^A..^Z
    if (e.key === '[') return '\x1b';
    return null;
  }
  switch (e.key) {
    case 'Enter': return '\r';
    case 'Backspace': return '\x7f';
    case 'Tab': return '\t';
    case 'Escape': return '\x1b';
    case 'ArrowUp': return '\x1b[A';
    case 'ArrowDown': return '\x1b[B';
    case 'ArrowRight': return '\x1b[C';
    case 'ArrowLeft': return '\x1b[D';
    case 'Home': return '\x1b[H';
    case 'End': return '\x1b[F';
    case 'Delete': return '\x1b[3~';
    case 'PageUp': return '\x1b[5~';
    case 'PageDown': return '\x1b[6~';
    default: return e.key.length === 1 ? e.key : null; // printable char; ignore F-keys etc.
  }
}
// Capture keydown on the terminal CONTAINER in the CAPTURE phase. xterm registers its own keydown
// handler on the textarea in capture phase and stopsPropagation on keys it handles — so a bubble-phase
// listener here received nothing (that was the bug). A capture-phase listener on the ancestor (termEl)
// runs BEFORE the textarea's, so we get the key first; stopImmediatePropagation keeps xterm from also
// acting on it. Gated to when the terminal textarea is focused; unhandled keys (Cmd/Option, copy/paste,
// F-keys) fall through to xterm/the browser.
termEl.addEventListener('keydown', (e) => {
  if (e.isComposing || document.activeElement !== termTextarea) return;
  const bytes = keyToPaneBytes(e);
  if (bytes == null) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  sendToPane(bytes);
}, { capture: true });
termEl.addEventListener('paste', (e) => {
  if (document.activeElement !== termTextarea) return;
  const text = e.clipboardData?.getData('text');
  if (!text) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  sendToPane(text);
}, { capture: true });
const conversationEl = $('#conversation');
const agentEl = $('#agent-view');
const scrollbackEl = $('#scrollback');
const scrollbackText = $('#scrollback-text');
const scrollbackMeta = $('#scrollback-meta');
const jumpLatest = document.createElement('button');
jumpLatest.type = 'button';
jumpLatest.className = 'jump-latest';
jumpLatest.textContent = 'Latest';
jumpLatest.hidden = true;
termEl.appendChild(jumpLatest);
// Cue (top-right, shown only while the terminal is focused) so it's clear this is the live input and
// Enter — not the message box's ↑ button — submits it to the agent.
const termHint = document.createElement('div');
termHint.className = 'term-hint';
termHint.textContent = '↵ Enter sends · this is the live terminal';
termEl.appendChild(termHint);
let followTail = true;
let userPausedTail = false;
let lastDims = '';
let lastTrustedResizeActivity = 0;
const requestedMainView = params.get('view');
const MAIN_VIEWS = new Set(['terminal', 'scrollback', 'conversation', 'agent', 'story']);
let activeMainView = MAIN_VIEWS.has(requestedMainView) ? requestedMainView : localStorage.getItem(PREF_MAIN_VIEW) || 'story'; // design handoff: story is the default log view
let timelineLoaded = false;
let latestTimelineData = null;
let agentViewApi = null;
let agentViewLoading = null;
let latestAgentData = null;
let scrollbackLoaded = false;
let scrollbackBusy = false;
let scrollbackFollow = true;
let scrollbackTimer = 0;
let selectedAgentRequestId = '';
let latestMap = null;
let mapBusy = false;
const timelineOpenGroups = new Set();
const timelineClosedGroups = new Set();

async function loadAgentView({ refresh = false } = {}) {
  if (!agentEl) return;
  if (!agentViewApi) {
    if (!agentViewLoading) {
      agentViewLoading = import('./agent_view.js').then((mod) => {
        agentViewApi = mod.createAgentView({
          root: agentEl,
          sessionId: id,
          onData(data) {
            latestAgentData = data;
            if (!selectedAgentRequestId) {
              selectedAgentRequestId = data?.groups?.findLast?.((g) => g.kind === 'request')?.id || '';
            }
            if (latestMap && !latestMap?.map?.map) renderMap(latestMap);
          },
          onSelectRequest(group, data) {
            selectedAgentRequestId = group?.id || '';
            latestAgentData = data || latestAgentData;
            if (latestMap && !latestMap?.map?.map) renderMap(latestMap);
          },
        });
        return agentViewApi;
      }).catch((e) => {
        agentEl.innerHTML = `<div class="timeline-empty">Failed to load Agent View: ${escapeHtml(e.message || String(e))}</div>`;
        throw e;
      });
    }
    await agentViewLoading;
  }
  await agentViewApi.load({ refresh });
}

function isScrollbackAtBottom() {
  if (!scrollbackEl) return true;
  return scrollbackEl.scrollHeight - scrollbackEl.scrollTop - scrollbackEl.clientHeight < 48;
}

function scrollbackToLatest() {
  if (!scrollbackEl) return;
  scrollbackEl.scrollTop = scrollbackEl.scrollHeight;
  scrollbackFollow = true;
}

async function loadScrollback({ quiet = false } = {}) {
  if (!scrollbackEl || !scrollbackText || scrollbackBusy) return;
  scrollbackBusy = true;
  const shouldFollow = scrollbackFollow || isScrollbackAtBottom();
  if (!scrollbackLoaded && !quiet) scrollbackText.textContent = 'Loading transcript...';
  try {
    const r = await api(`api/session/${id}/log?max=524288`);
    scrollbackText.textContent = r.text || '(no terminal log yet)';
    const meta = [r.truncated ? 'tail' : 'full', fmtBytes(r.bytes), r.totalBytes && r.totalBytes !== r.bytes ? `of ${fmtBytes(r.totalBytes)}` : '']
      .filter(Boolean)
      .join(' ');
    if (scrollbackMeta) scrollbackMeta.textContent = meta;
    scrollbackLoaded = true;
    if (shouldFollow) requestAnimationFrame(scrollbackToLatest);
  } catch (e) {
    scrollbackText.textContent = `Failed to load transcript: ${e.message || String(e)}`;
  } finally {
    scrollbackBusy = false;
  }
}

function scheduleScrollbackRefresh(delay = 600) {
  if (activeMainView !== 'scrollback') return;
  clearTimeout(scrollbackTimer);
  scrollbackTimer = setTimeout(() => loadScrollback({ quiet: true }), delay);
}

scrollbackEl?.addEventListener('scroll', () => {
  scrollbackFollow = isScrollbackAtBottom();
});
$('#scrollback-refresh')?.addEventListener('click', () => loadScrollback());
$('#scrollback-latest')?.addEventListener('click', () => {
  scrollbackFollow = true;
  loadScrollback({ quiet: true }).then(scrollbackToLatest);
});

function setMainView(view) {
  activeMainView = MAIN_VIEWS.has(view) ? view : 'terminal';
  localStorage.setItem(PREF_MAIN_VIEW, activeMainView);
  shell.classList.toggle('conversation-mode', activeMainView === 'conversation');
  shell.classList.toggle('agent-mode', activeMainView === 'agent');
  shell.classList.toggle('scrollback-mode', activeMainView === 'scrollback');
  shell.classList.toggle('story-mode', activeMainView === 'story'); // hides quick-keys (terminal-only per spec)
  document.querySelectorAll('[data-story-toggle] [data-mode]').forEach((b) => {
    b.classList.toggle('active', (b.dataset.mode === 'story') === (activeMainView === 'story'));
  });
  document.querySelectorAll('[data-main-view]').forEach((b) => {
    const on = b.dataset.mainView === activeMainView;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('[data-main-panel]').forEach((p) => {
    p.hidden = p.dataset.mainPanel !== activeMainView;
  });
  if (activeMainView === 'story') loadStoryView();
  else if (activeMainView === 'conversation') loadTimeline();
  else if (activeMainView === 'agent') setTimeout(() => loadAgentView(), 0);
  else if (activeMainView === 'scrollback') loadScrollback();
  else setTimeout(syncSize, 80);
}
document.querySelectorAll('[data-main-view]').forEach((b) => {
  b.onclick = () => setMainView(b.dataset.mainView);
});
// Story/terminal segmented toggle (design handoff DOM contract).
document.querySelectorAll('[data-story-toggle] [data-mode]').forEach((b) => {
  b.onclick = () => setMainView(b.dataset.mode === 'story' ? 'story' : 'terminal');
});
let storyInited = false;
async function loadStoryView() {
  const mod = await import('./story-view.js');
  if (!storyInited) { storyInited = true; mod.initStoryView({ sessionId: id, panel: document.querySelector('[data-story-panel]') }); }
  else mod.refreshStory();
}
setMainView(activeMainView);

function terminalBottomDistance() {
  const b = term.buffer?.active;
  return b ? Math.max(0, Number(b.baseY || 0) - Number(b.viewportY || 0)) : 0;
}

function isTerminalAtBottom(toleranceRows = 2) {
  return terminalBottomDistance() <= toleranceRows;
}

function updateJumpLatest() {
  const threshold = Math.max(8, Math.ceil((term.rows || 1) * 1.5));
  jumpLatest.hidden = terminalBottomDistance() <= threshold;
}

function terminalShouldFollow() {
  return !userPausedTail && (followTail || isTerminalAtBottom());
}

function scrollTerminalToLatest() {
  term.scrollToBottom();
  userPausedTail = false;
  followTail = true;
  updateJumpLatest();
}

function pauseTerminalFollow() {
  if (isTerminalAtBottom()) return;
  userPausedTail = true;
  followTail = false;
  updateJumpLatest();
}

let terminalCellProbe = null;

function px(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function terminalPadding() {
  if (!term.element) return { left: 0, right: 0, top: 0, bottom: 0 };
  const style = getComputedStyle(term.element);
  return {
    left: px(style.paddingLeft),
    right: px(style.paddingRight),
    top: px(style.paddingTop),
    bottom: px(style.paddingBottom),
  };
}

function measuredTerminalCell() {
  if (!terminalCellProbe) {
    terminalCellProbe = document.createElement('span');
    terminalCellProbe.textContent = 'M'.repeat(80);
    terminalCellProbe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:pre;pointer-events:none;';
    termEl.appendChild(terminalCellProbe);
  }
  terminalCellProbe.style.fontFamily = term.options.fontFamily;
  terminalCellProbe.style.fontSize = `${term.options.fontSize}px`;
  const rect = terminalCellProbe.getBoundingClientRect();
  return { width: rect.width / 80, height: rect.height };
}

function terminalCellSize() {
  const cell = term._core?._renderService?.dimensions?.css?.cell;
  const measured = measuredTerminalCell();
  let width = Number(cell?.width || 0);
  let height = Number(cell?.height || 0);
  const screen = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
  if (!width || !Number.isFinite(width)) width = measured.width;
  if (!height || !Number.isFinite(height)) height = measured.height;
  // If xterm was first fit while its grid area was still settling, its internal
  // cell metrics can become self-consistent with the stale column count. Compare
  // against an independent DOM probe so the watchdog can still see stale cols.
  if (measured.width && (width > measured.width * 1.35 || width < measured.width * 0.65)) width = measured.width;
  if (measured.height && (height > measured.height * 1.6 || height < measured.height * 0.5)) height = measured.height;
  if ((!width || !Number.isFinite(width)) && screen?.width && term.cols) width = screen.width / term.cols;
  if ((!height || !Number.isFinite(height)) && screen?.height && term.rows) height = screen.height / term.rows;
  return { width, height };
}

function terminalLayoutMetrics() {
  const pad = terminalPadding();
  const cell = terminalCellSize();
  const availableWidth = Math.max(0, termEl.clientWidth - pad.left - pad.right);
  const availableHeight = Math.max(0, termEl.clientHeight - pad.top - pad.bottom);
  const screenRect = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
  const screenWidth = screenRect?.width || (cell.width > 0 ? term.cols * cell.width : 0);
  const screenRatio = availableWidth > 0 && screenWidth > 0 ? screenWidth / availableWidth : 1;
  const scrollbarWidth = Number(term._core?._viewport?.scrollBarWidth || 0);
  const colsCapacity = cell.width > 0 ? Math.max(2, Math.floor((availableWidth - scrollbarWidth) / cell.width)) : term.cols;
  const rowsCapacity = cell.height > 0 ? Math.max(1, Math.floor(availableHeight / cell.height)) : term.rows;
  return { availableWidth, availableHeight, screenWidth, screenRatio, colsCapacity, rowsCapacity, cellWidth: cell.width, cellHeight: cell.height };
}

function fitTerminal() {
  const before = `${term.cols}x${term.rows}`;
  fit.fit();
  const metrics = terminalLayoutMetrics();
  const refreshIfChanged = () => {
    if (`${term.cols}x${term.rows}` !== before) term.refresh?.(0, Math.max(0, term.rows - 1));
  };
  if (metrics.screenRatio >= 0.96 && Math.abs(metrics.colsCapacity - term.cols) <= 2) {
    refreshIfChanged();
    return;
  }
  if (!metrics.cellWidth || !metrics.cellHeight || !Number.isFinite(metrics.cellWidth) || !Number.isFinite(metrics.cellHeight)) return;
  if (metrics.colsCapacity !== term.cols || metrics.rowsCapacity !== term.rows) {
    term.resize(metrics.colsCapacity, metrics.rowsCapacity);
  }
  refreshIfChanged();
}

function healTerminalLayout() {
  if (!termEl.isConnected || document.hidden) return;
  const metrics = terminalLayoutMetrics();
  if (metrics.screenRatio < 0.96 || Math.abs(metrics.colsCapacity - term.cols) > 2 || Math.abs(metrics.rowsCapacity - term.rows) > 1) scheduleSyncSize(0);
}

function syncSize() {
  if (document.hidden || activeMainView !== 'terminal') return;
  if (!termEl.isConnected || termEl.clientWidth <= 0 || termEl.clientHeight <= 0) return;
  const shouldFollow = terminalShouldFollow();
  fitTerminal();
  if (shouldFollow) scrollTerminalToLatest();
  else updateJumpLatest();
  const dims = `${term.cols}x${term.rows}`;
  if (dims === lastDims) return;
  lastDims = dims;
  if (automatedResizeClient()) return;
  api(`api/session/${id}/resize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cols: term.cols,
      rows: term.rows,
      clientId: resizeClientId,
      visible: !document.hidden,
      focused: document.hasFocus(),
      interactive: Date.now() - lastTrustedResizeActivity < RESIZE_INTERACTIVE_WINDOW_MS,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1 },
    }),
  }).catch(() => {});
}
let rzTimer;
function scheduleSyncSize(delay = 0) {
  clearTimeout(rzTimer);
  rzTimer = setTimeout(syncSize, delay);
}
// Presence ping (visible true/false), independent of the lastDims size guard. The tmux window is sized to
// the NARROWEST active viewer, so a wide tab that goes to the background must drop out of the pool at once —
// otherwise every other (narrower) viewer's pane stays over-wide and the agent TUI wraps into a garbled
// sliver until this client's entry finally ages out. On return we re-register visible:true right away, since
// syncSize would otherwise skip re-posting when the dimensions haven't changed.
function reportResizePresence(visible) {
  if (automatedResizeClient() || !term.cols || !term.rows) return;
  const body = JSON.stringify({
    cols: term.cols,
    rows: term.rows,
    clientId: resizeClientId,
    visible,
    focused: document.hasFocus(),
    interactive: false,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1 },
  });
  try {
    if (!visible && navigator.sendBeacon) {
      navigator.sendBeacon(`api/session/${id}/resize`, new Blob([body], { type: 'application/json' }));
      return;
    }
  } catch {}
  fetch(`api/session/${id}/resize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
}
function noteTrustedResizeActivity(e) {
  if (e && e.isTrusted === false) return;
  lastTrustedResizeActivity = Date.now();
  scheduleSyncSize(80);
}
addEventListener('pointerdown', noteTrustedResizeActivity, { capture: true, passive: true });
addEventListener('touchstart', noteTrustedResizeActivity, { capture: true, passive: true });
addEventListener('keydown', noteTrustedResizeActivity, { capture: true });
jumpLatest.onclick = scrollTerminalToLatest;
let lastUserTermScroll = 0;
const markUserTermScroll = () => {
  lastUserTermScroll = Date.now();
  setTimeout(pauseTerminalFollow, 0);
};
// Full-screen TUIs (Claude Code) run on the alternate screen, which has no xterm scrollback of its own —
// so the wheel can't scroll it locally. Claude enables SGR mouse tracking precisely so the terminal
// forwards the wheel to it and IT scrolls its own transcript (exactly how it behaves in iTerm/Terminal).
// Supercalm forwards keystrokes but not mouse, so those wheels were dropped and the session looked frozen.
// Forward ONLY the wheel to the pane (as SGR mouse events) when the app has mouse tracking on — clicks and
// drags stay local so text selection + copy keep working. When mouse tracking is off (Codex on the main
// buffer, or a Claude modal), fall back to xterm's normal scrollback scroll.
function appMouseTrackingOn() {
  const m = term.modes?.mouseTrackingMode;
  if (m) return m !== 'none';
  return !!term._core?.coreMouseService?.areMouseEventsActive; // fallback if .modes is unavailable
}
function wheelPaneCell(e) {
  const rect = (term.element?.querySelector('.xterm-screen') || termEl).getBoundingClientRect();
  const cell = terminalCellSize();
  const col = cell.width > 0 ? Math.min(term.cols, Math.max(1, Math.floor((e.clientX - rect.left) / cell.width) + 1)) : 1;
  const row = cell.height > 0 ? Math.min(term.rows, Math.max(1, Math.floor((e.clientY - rect.top) / cell.height) + 1)) : 1;
  return { col, row };
}
termEl.addEventListener('wheel', (e) => {
  if (appMouseTrackingOn()) {
    e.preventDefault(); // the app owns this scroll; don't also scroll the page/xterm
    const { col, row } = wheelPaneCell(e);
    const btn = e.deltaY < 0 ? 64 : 65; // SGR mouse wheel: 64 = up, 65 = down
    const raw = e.deltaMode === 1 ? Math.abs(e.deltaY) : Math.abs(e.deltaY) / 24; // lines vs pixels
    const lines = Math.min(8, Math.max(1, Math.round(raw)));
    let seq = '';
    for (let i = 0; i < lines; i++) seq += `\x1b[<${btn};${col};${row}M`;
    sendToPane(seq);
    return;
  }
  markUserTermScroll();
}, { passive: false });
termEl.addEventListener('touchstart', markUserTermScroll, { passive: true });
termEl.addEventListener('pointerdown', (e) => {
  if (!jumpLatest.contains(e.target)) markUserTermScroll();
});
termEl.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) markUserTermScroll();
});
term.onScroll(() => {
  if (isTerminalAtBottom()) {
    userPausedTail = false;
    followTail = true;
  } else if (Date.now() - lastUserTermScroll < 1500) {
    pauseTerminalFollow();
  }
  updateJumpLatest();
});
addEventListener('resize', () => {
  scheduleSyncSize(150);
});
addEventListener('orientationchange', () => {
  scheduleSyncSize(250);
});
addEventListener('focus', () => scheduleSyncSize(0));
document.addEventListener('visibilitychange', () => {
  reportResizePresence(!document.hidden); // drop out of / rejoin the shared-size pool immediately
  if (!document.hidden) scheduleSyncSize(0);
});
addEventListener('pagehide', () => reportResizePresence(false));
if ('ResizeObserver' in window) {
  const ro = new ResizeObserver(() => {
    scheduleSyncSize(120);
  });
  ro.observe(termEl);
  ro.observe(shell);
  ro.observe(document.querySelector('.session-main'));
}
if (document.fonts?.ready) document.fonts.ready.then(() => scheduleSyncSize(0)).catch(() => {});
[0, 60, 250, 800, 1600].forEach((delay) => setTimeout(syncSize, delay));
setInterval(healTerminalLayout, 1500);
// The terminal sometimes becomes stale after async UI below it settles without a
// browser ResizeObserver event. A light fit pass is cheap; API resize is still
// guarded by lastDims, so this does not spam tmux unless dimensions really change.
setInterval(() => {
  if (!document.hidden) scheduleSyncSize(0);
}, 5000);
window.__aiosTerminalMetrics = () => ({
  cols: term.cols,
  rows: term.rows,
  baseY: term.buffer?.active?.baseY || 0,
  viewportY: term.buffer?.active?.viewportY || 0,
  bottomDistance: terminalBottomDistance(),
  ...terminalLayoutMetrics(),
  followTail,
  userPausedTail,
});
window.__aiosScrollTop = () => {
  term.scrollToTop();
  pauseTerminalFollow();
  updateJumpLatest();
};
window.__aiosScrollLatest = scrollTerminalToLatest;

// ---- live stream ------------------------------------------------------------
function b64bytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function writeTerminal(data) {
  const shouldFollow = terminalShouldFollow();
  term.write(data, () => {
    if (shouldFollow) scrollTerminalToLatest();
    else updateJumpLatest();
  });
}
const terminalDecoder = new TextDecoder();
let terminalControlCarry = '';
let terminalControlFlushTimer = 0;
const TERMINAL_CONTROL_CARRY_CHARS = 32;
function stripBrowserOnlyTerminalControls(text) {
  // Only CSI 3J (erase-scrollback, used by Codex during main-buffer redraws) is dropped, so the browser
  // keeps readable history. We DELIBERATELY no longer strip the alternate-screen switch (47/1047/1048/
  // 1049): Claude Code is a full-screen TUI that enters the alt screen at startup and draws its entire UI
  // with absolute cursor positioning. If the browser stays on the main buffer while tmux is on the alt
  // buffer, every positioned redraw lands at the wrong row and the UI tears into a garbled sliver. The
  // browser must mirror tmux's screen exactly; full history for such sessions lives in the Scrollback tab.
  return String(text || '').replace(/\x1b\[[0-?]*3J/g, '');
}
function flushTerminalControlCarry() {
  if (!terminalControlCarry) return;
  const text = stripBrowserOnlyTerminalControls(terminalControlCarry);
  terminalControlCarry = '';
  if (text) writeTerminal(text);
}
function writeTerminalBytes(data) {
  const decoded = terminalDecoder.decode(data, { stream: true });
  const combined = terminalControlCarry + decoded;
  const keep = Math.min(TERMINAL_CONTROL_CARRY_CHARS, combined.length);
  const emit = combined.slice(0, combined.length - keep);
  terminalControlCarry = combined.slice(combined.length - keep);
  const text = stripBrowserOnlyTerminalControls(emit);
  if (text) writeTerminal(text);
  clearTimeout(terminalControlFlushTimer);
  terminalControlFlushTimer = setTimeout(flushTerminalControlCarry, 40);
}
if (params.has('debugTerminal')) {
  window.__aiosTerminalTestWrite = (text) => writeTerminal(String(text || ''));
  window.__aiosForceTerminalResize = (cols = 48, rows = term.rows) => {
    term.resize(Math.max(2, Number(cols) || 48), Math.max(1, Number(rows) || term.rows));
    term.refresh?.(0, Math.max(0, term.rows - 1));
    updateJumpLatest();
  };
  window.__aiosTermSelectAll = () => term.selectAll();
  window.__aiosTermDewrap = (s, w) => dewrapTerminalText(s, w ?? term.cols);
}
async function bootstrapTerminalScrollback() {
  if (params.has('noTerminalHistory')) return;
  try {
    const r = await api(`api/session/${id}/log?max=196608`);
    if (!r?.text) return;
    const normalized = String(r.text).replace(/\n/g, '\r\n');
    if (normalized.trim()) {
      writeTerminal(normalized + '\r\n');
      scrollTerminalToLatest();
    }
  } catch {}
}

// Open long-lived SSE connections only AFTER the initial load settles — an eagerly-opened stream is a
// permanent in-flight request that keeps the page from ever reaching network-idle (verify_shell_v3
// waits on that). requestIdleCallback fires in the first idle window; live updates start a beat later,
// imperceptibly, and the bootstrap scrollback already shows the current terminal.
const afterIdle = (fn) => setTimeout(() => (window.requestIdleCallback || ((f) => f()))(fn), 2500);
let terminalStream = null;
function startTerminalStream() {
  terminalStream = new EventSource(`api/session/${id}/stream`);
  terminalStream.addEventListener('data', (e) => {
    writeTerminalBytes(b64bytes(e.data));
    scheduleScrollbackRefresh();
  });
  terminalStream.addEventListener('ended', () => {
    flushTerminalControlCarry();
    writeTerminal('\r\n\x1b[90m-- session ended --\x1b[0m');
  });
  terminalStream.onerror = () => {}; // EventSource auto-reconnects
}
bootstrapTerminalScrollback().finally(() => afterIdle(startTerminalStream));

// ---- rich conversation timeline --------------------------------------------
function fmtBytes(v) {
  const n = Number(v || 0);
  if (!n) return '';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function detailKeyAttr(key) {
  return key ? ` data-detail-key="${escapeHtml(String(key))}"` : '';
}

function timelineDetails(label, inner, open = false, key = '') {
  if (!inner) return '';
  return `<details${detailKeyAttr(key)} ${open ? 'open' : ''}><summary>${escapeHtml(label)}</summary>${inner}</details>`;
}

function timelinePre(text, cls = 'timeline-text') {
  return `<pre class="${cls}">${escapeHtml(text || '')}</pre>`;
}

function diffLineClass(line) {
  if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) return 'file';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return '';
}

function renderDiffText(text) {
  const lines = String(text || '').split('\n');
  return `<pre class="timeline-diff">${lines.map((line) => `<span class="diff-line ${diffLineClass(line)}">${escapeHtml(line || ' ')}</span>`).join('')}</pre>`;
}

function renderTimelineAttachment(a = {}) {
  const meta = [a.format, fmtBytes(a.size)].filter(Boolean).join(' · ');
  const url = a.url ? escapeHtml(a.url) : '';
  const visual = a.isImage && url
    ? `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${escapeHtml(a.name || 'attachment')}" loading="lazy" /></a>`
    : `<div class="timeline-file-icon">${escapeHtml(a.format || 'FILE')}</div>`;
  const linkName = url
    ? `<a class="timeline-attachment-name" href="${url}" target="_blank" rel="noopener">${escapeHtml(a.name || 'attachment')}</a>`
    : `<span class="timeline-attachment-name">${escapeHtml(a.name || 'attachment')}</span>`;
  return `
    <div class="timeline-attachment">
      ${visual}
      <div class="timeline-attachment-main">
        ${linkName}
        <span class="timeline-attachment-path">${escapeHtml(meta || a.type || a.path || '')}</span>
      </div>
    </div>`;
}

function timelineHead(b) {
  return `
    <div class="timeline-head">
      <span class="timeline-title">${escapeHtml(b.title || b.type || 'Event')}</span>
      <span class="timeline-time">${escapeHtml(timeLabel(b.ts))}</span>
    </div>`;
}

function renderTimelineBlock(b) {
  const tags = [
    b.type !== 'event' ? b.type : b.subtype,
    b.category,
    b.status,
    b.source,
  ].filter(Boolean);
  const tagHtml = tags.length ? `<div class="timeline-meta">${tags.map((t) => `<span class="timeline-tag">${escapeHtml(t)}</span>`).join('')}</div>` : '';
  const summary = b.summary ? `<div class="timeline-summary">${escapeHtml(b.summary)}</div>` : '';
  if (b.type === 'message') {
    const attachments = (b.attachments || []).length ? `<div class="timeline-attachments">${b.attachments.map(renderTimelineAttachment).join('')}</div>` : '';
    return `
      <article class="timeline-card message ${b.role || ''}">
        ${timelineHead(b)}
        ${tagHtml}
        ${summary}
        ${attachments}
        ${timelineDetails('Message text', timelinePre(b.text), false)}
      </article>`;
  }
  if (b.type === 'decision') {
    const response = b.response ? timelineDetails('Your response', timelinePre(b.response), false) : '';
    const ask = b.ask ? timelineDetails('Full ask', timelinePre(b.ask), b.status === 'pending') : '';
    return `
      <article class="timeline-card decision">
        ${timelineHead(b)}
        ${tagHtml}
        ${summary}
        ${ask}
        ${response}
      </article>`;
  }
  if (b.type === 'attachment') {
    const attachments = b.attachments || (b.attachment ? [b.attachment] : []);
    return `
      <article class="timeline-card attachment">
        ${timelineHead(b)}
        ${summary}
        <div class="timeline-attachments">${attachments.map(renderTimelineAttachment).join('')}</div>
      </article>`;
  }
  if (b.type === 'diff') {
    const stat = b.stat ? `<pre class="timeline-diff-stat">${escapeHtml(b.stat)}</pre>` : '';
    const status = b.status ? timelineDetails('Changed paths', timelinePre(b.status), !b.diff) : '';
    const diff = b.diff ? timelineDetails(b.truncated ? 'Diff preview (truncated)' : 'Diff', renderDiffText(b.diff), false) : '';
    const error = b.error ? `<div class="timeline-summary">${escapeHtml(b.error)}</div>` : '';
    return `
      <article class="timeline-card diff">
        ${timelineHead(b)}
        ${tagHtml}
        ${summary}
        ${stat}
        ${error}
        ${status}
        ${diff}
      </article>`;
  }
  if (b.type === 'terminal') {
    return `
      <article class="timeline-card terminal">
        ${timelineHead(b)}
        ${summary}
        ${timelineDetails('Terminal output', timelinePre(b.text), false)}
      </article>`;
  }
  const payload = b.payload ? JSON.stringify(b.payload, null, 2) : '';
  return `
    <article class="timeline-card event ${escapeHtml(b.subtype || '')}">
      ${timelineHead(b)}
      ${tagHtml}
      ${summary}
      ${timelineDetails('Payload', timelinePre(payload), false)}
    </article>`;
}

function compactText(text, max = 180) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : s;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${Number(n) === 1 ? one : many}`;
}

function wordCountLabel(text) {
  const count = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return count ? plural(count, 'word') : '';
}

function lastNonEmptyLine(text, max = 80) {
  const line = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
  return compactText(line || '', max);
}

function blockAttachments(b) {
  return b?.attachments || (b?.attachment ? [b.attachment] : []);
}

function timelineCounts(items = []) {
  return items.reduce((acc, b) => {
    if (b.type === 'message') acc.messages += 1;
    if (b.type === 'message' && b.role === 'user') acc.requests += 1;
    if (b.type === 'decision') acc.decisions += 1;
    if (b.type === 'decision' && b.status === 'pending') acc.pending += 1;
    if (b.type === 'attachment') acc.attachmentEvents += 1;
    if (b.type === 'diff') acc.diffs += 1;
    if (b.type === 'terminal') acc.terminal += 1;
    if (b.type === 'event') acc.events += 1;
    acc.attachments += blockAttachments(b).length;
    return acc;
  }, { messages: 0, requests: 0, decisions: 0, pending: 0, attachments: 0, attachmentEvents: 0, diffs: 0, terminal: 0, events: 0 });
}

function groupSignals(items = []) {
  const text = items.map((b) => [b.title, b.summary, b.text].filter(Boolean).join(' ')).join(' ').toLowerCase();
  const signals = [];
  if (items.some((b) => b.type === 'diff')) signals.push('Changes');
  if (items.some((b) => b.type === 'decision' && b.status === 'pending')) signals.push('Needs review');
  if (/\b(test|tests|tested|verify|verified|qa|screenshot|playwright|node --check|lint)\b/.test(text)) signals.push('QA');
  if (/\b(plan|approach|steps|strategy)\b/.test(text)) signals.push('Plan');
  if (/\b(done|completed|implemented|fixed|shipped|finished|result)\b/.test(text)) signals.push('Result');
  if (items.some((b) => blockAttachments(b).length)) signals.push('Files');
  return [...new Set(signals)].slice(0, 4);
}

function makeGroup(kind, ts, items = []) {
  return { id: '', kind, ts, items: [...items], title: '', summary: '', counts: {}, signals: [] };
}

function buildTimelineGroups(blocks = []) {
  const groups = [];
  let current = null;
  const currentEvidence = [];

  function pushGroup(g) {
    if (g && g.items.length) groups.push(g);
  }

  for (const b of blocks) {
    if (b.type === 'diff' || b.type === 'terminal') {
      currentEvidence.push(b);
      continue;
    }
    if (b.type === 'message' && b.role === 'user') {
      pushGroup(current);
      current = makeGroup('request', b.ts, [b]);
      continue;
    }
    if (!current) {
      current = makeGroup('setup', b.ts, [b]);
    } else {
      current.items.push(b);
    }
  }
  pushGroup(current);
  if (currentEvidence.length) {
    let target = [...groups].reverse().find((g) => g.kind === 'request') || groups[groups.length - 1];
    if (!target) {
      target = makeGroup('setup', currentEvidence[0].ts, []);
      groups.push(target);
    }
    target.items.push(...currentEvidence);
  }

  return groups.map((g, i) => {
    const counts = timelineCounts(g.items);
    const first = g.items[0] || {};
    const firstUser = g.items.find((b) => b.type === 'message' && b.role === 'user');
    const pending = g.items.find((b) => b.type === 'decision' && b.status === 'pending');
    const latestOutcome = [...g.items].reverse().find((b) => (
      b.type === 'decision' ||
      (b.type === 'message' && b.role !== 'user') ||
      b.type === 'diff' ||
      b.type === 'event'
    ));
    const titleSource =
      g.kind === 'request' ? firstUser :
      pending || first;
    const defaultTitle =
      g.kind === 'request' ? 'Request' :
      g.kind === 'setup' ? 'Session setup' :
      'Update';
    const titleText = compactText(titleSource?.summary || titleSource?.title || defaultTitle, g.kind === 'request' ? 96 : 72);
    const summaryText = compactText(
      (latestOutcome && latestOutcome !== firstUser ? latestOutcome.summary : '') ||
      firstUser?.summary ||
      first.summary ||
      '',
      220
    );
    return {
      ...g,
      id: `timeline-group-${i}-${g.kind}-${String(first.id || i).replace(/[^A-Za-z0-9_-]/g, '-')}`,
      title: titleText || defaultTitle,
      summary: summaryText,
      counts,
      signals: groupSignals(g.items),
      ts: Number(g.ts || first.ts || 0),
      endTs: Number(g.items[g.items.length - 1]?.ts || g.ts || first.ts || 0),
    };
  });
}

function groupLabel(g) {
  if (g.kind === 'setup') return 'Setup';
  if (g.counts.pending) return 'Needs Review';
  if (g.kind === 'request') return 'Request';
  if (g.signals.includes('QA')) return 'QA';
  if (g.signals.includes('Plan')) return 'Plan';
  if (g.signals.includes('Result')) return 'Result';
  return 'Update';
}

function groupMetaChips(g) {
  const chips = [];
  if (g.counts.diffs) chips.push(`${g.counts.diffs} change${g.counts.diffs === 1 ? '' : 's'}`);
  if (g.counts.terminal) chips.push(`${g.counts.terminal} terminal`);
  if (g.counts.decisions) chips.push(plural(g.counts.decisions, 'decision'));
  if (g.counts.attachments) chips.push(plural(g.counts.attachments, 'file'));
  if (g.counts.events && g.kind === 'setup') chips.push(plural(g.counts.events, 'event'));
  const signals = g.signals.filter((s) => !['Changes', 'Files'].includes(s));
  return [...chips, ...signals].slice(0, 4);
}

function groupStatus(g, i, groups) {
  if (g.counts.pending) return { cls: 'needs-review', label: 'Needs review' };
  const lastRequest = groups.findLastIndex((x) => x.kind === 'request');
  if (i === lastRequest) return { cls: 'active', label: 'Active' };
  if (g.kind === 'setup') return { cls: 'setup', label: 'Setup' };
  return { cls: 'done', label: 'Done' };
}

function renderTimelineOverview(data = {}, blocks = [], groups = []) {
  const stats = data.stats || {};
  const session = data.session || {};
  const latest = [...blocks].reverse().find((b) => b.type !== 'terminal');
  const diff = blocks.find((b) => b.type === 'diff');
  const pending = blocks.filter((b) => b.type === 'decision' && b.status === 'pending').length;
  const requestCount = blocks.filter((b) => b.type === 'message' && b.role === 'user').length;
  const requestGroups = groups.filter((g) => g.kind === 'request').length || requestCount;
  const status = [session.status, session.toolLabel || session.tool, session.modelLabel || session.model].filter(Boolean).join(' · ');
  const summary = compactText(latest?.summary || session.title || 'Session timeline', 240);
  const pills = [
    [requestGroups, 'requests'],
    [stats.attachments || 0, 'files'],
    [stats.diffs || 0, 'change sets'],
    pending ? [pending, 'open asks'] : null,
  ].filter(Boolean);
  return `
    <section class="timeline-overview" data-agent-kind="overview">
      <div class="timeline-overview-main">
        <div class="timeline-overview-title">${escapeHtml(session.title || 'Conversation')}</div>
        <div class="timeline-overview-summary">${escapeHtml(summary)}</div>
        <div class="timeline-overview-status">${escapeHtml(status)}${diff?.summary ? ` · ${escapeHtml(diff.summary)}` : ''}</div>
      </div>
      <div class="timeline-overview-pills">
        ${pills.map(([value, label]) => `<span class="timeline-pill"><b>${escapeHtml(value)}</b> ${escapeHtml(label)}</span>`).join('')}
        <span class="timeline-pill">Updated ${escapeHtml(timeLabel(data.generatedAt))}</span>
      </div>
    </section>`;
}

function renderTimelineNotes(items = []) {
  const notes = [];
  const user = items.find((b) => b.type === 'message' && b.role === 'user');
  if (user) {
    notes.push(`
      <div class="timeline-note request">
        <span class="timeline-note-k">Request</span>
        <span class="timeline-note-v">${escapeHtml(compactText(user.text || user.summary, 360))}</span>
      </div>`);
  }
  const decisions = items.filter((b) => b.type === 'decision');
  decisions.slice(-3).forEach((d) => {
    notes.push(`
      <div class="timeline-note decision ${escapeHtml(d.status || '')}">
        <span class="timeline-note-k">${escapeHtml(d.status === 'pending' ? 'Open ask' : d.category || 'Decision')}</span>
        <span class="timeline-note-v">${escapeHtml(compactText(d.summary || d.question || d.ask, 320))}${d.response ? `<span class="timeline-note-response">You: ${escapeHtml(compactText(d.response, 220))}</span>` : ''}</span>
      </div>`);
  });
  items.filter((b) => b.type === 'event' && b.subtype !== 'session').slice(-2).forEach((e) => {
    notes.push(`
      <div class="timeline-note event">
        <span class="timeline-note-k">${escapeHtml(e.title || 'Event')}</span>
        <span class="timeline-note-v">${escapeHtml(compactText(e.summary, 260))}</span>
      </div>`);
  });
  return notes.join('');
}

function timelineSection(label, inner, key, open = false, preview = '') {
  if (!inner) return '';
  const previewHtml = preview ? `<span class="timeline-section-preview">${escapeHtml(preview)}</span>` : '';
  return `<details${detailKeyAttr(key)} ${open ? 'open' : ''}><summary><span>${escapeHtml(label)}</span>${previewHtml}</summary><div class="timeline-section-body">${inner}</div></details>`;
}

function renderDecisionRows(decisions = []) {
  return decisions.map((d) => `
    <div class="timeline-section-item decision ${escapeHtml(d.status || '')}">
      <div class="timeline-section-head">
        <span>${escapeHtml(d.status === 'pending' ? 'Open ask' : d.category || 'Decision')}</span>
        <span>${escapeHtml(timeLabel(d.ts))}</span>
      </div>
      <div class="timeline-section-summary">${escapeHtml(compactText(d.summary || d.question || d.ask, 380))}</div>
      ${d.response ? `<div class="timeline-section-response">You: ${escapeHtml(compactText(d.response, 280))}</div>` : ''}
      ${d.ask ? timelineDetails('Full ask', timelinePre(d.ask), false) : ''}
      ${d.response ? timelineDetails('Your response', timelinePre(d.response), false) : ''}
    </div>`).join('');
}

function renderActivityRows(events = []) {
  return events.map((e) => `
    <div class="timeline-section-item activity">
      <div class="timeline-section-head">
        <span>${escapeHtml(e.title || e.subtype || 'Activity')}</span>
        <span>${escapeHtml(timeLabel(e.ts))}</span>
      </div>
      ${e.summary ? `<div class="timeline-section-summary">${escapeHtml(compactText(e.summary, 360))}</div>` : ''}
    </div>`).join('');
}

function renderChangesSection(diff) {
  if (!diff) return '';
  return `
    <div class="timeline-note changes">
      <span class="timeline-note-k">Changes</span>
      <span class="timeline-note-v">${escapeHtml(compactText(diff.summary, 260))}</span>
    </div>
    ${diff.stat ? `<pre class="timeline-diff-stat">${escapeHtml(diff.stat)}</pre>` : ''}
    ${diff.status ? timelineDetails('Changed paths', timelinePre(diff.status), true) : ''}
    ${diff.diff ? timelineDetails(diff.truncated ? 'Diff preview' : 'Diff', renderDiffText(diff.diff), false) : ''}`;
}

function renderGroupHighlights(g) {
  const user = g.items.find((b) => b.type === 'message' && b.role === 'user');
  const decisions = g.items.filter((b) => b.type === 'decision');
  const events = g.items.filter((b) => b.type === 'event' && b.subtype !== 'session');
  const attachments = g.items.flatMap(blockAttachments);
  const diff = g.items.find((b) => b.type === 'diff');
  const terminal = g.items.find((b) => b.type === 'terminal');
  const openDecisions = decisions.filter((d) => d.status === 'pending').length;
  const attachmentFormats = [...new Set(attachments.map((a) => a.format || a.type || 'file').filter(Boolean))].slice(0, 3).join(', ');
  const sections = [
    user ? timelineSection('Request text', timelinePre(user.text || user.summary), 'request-text', false, wordCountLabel(user.text || user.summary)) : '',
    decisions.length ? timelineSection(`${plural(decisions.length, 'decision')}`, renderDecisionRows(decisions), 'decisions', false, openDecisions ? `${openDecisions} open` : 'answered') : '',
    attachments.length ? timelineSection(`${plural(attachments.length, 'file')}`, `<div class="timeline-attachments compact">${attachments.map(renderTimelineAttachment).join('')}</div>`, 'files', false, attachmentFormats) : '',
    events.length ? timelineSection(`${plural(events.length, 'activity item')}`, renderActivityRows(events), 'activity', false, compactText(events[events.length - 1]?.summary || events[events.length - 1]?.title, 72)) : '',
    diff ? timelineSection('Changes', renderChangesSection(diff), 'changes', false, compactText(diff.summary || lastNonEmptyLine(diff.stat), 78)) : '',
    terminal ? timelineSection('Terminal evidence', timelinePre(terminal.text), 'terminal-evidence', false, compactText(terminal.summary || lastNonEmptyLine(terminal.text), 78)) : '',
  ].filter(Boolean).join('');
  const notes = renderTimelineNotes(g.items);
  const raw = timelineDetails('Event details', `<div class="timeline-raw-list">${g.items.map(renderTimelineBlock).join('')}</div>`, false, 'event-details');
  return `${notes}${sections ? `<div class="timeline-sections">${sections}</div>` : ''}${raw}`;
}

function groupDefaultOpen(g, i, groups) {
  if (timelineOpenGroups.has(g.id)) return true;
  if (timelineClosedGroups.has(g.id)) return false;
  if (g.counts.pending) return true;
  for (let j = groups.length - 1; j >= 0; j--) {
    if (groups[j].kind === 'request') return i === j;
  }
  return false;
}

function renderTimelineGroup(g, i, groups) {
  const label = groupLabel(g);
  const state = groupStatus(g, i, groups);
  const chips = groupMetaChips(g);
  const open = groupDefaultOpen(g, i, groups);
  return `
    <details class="timeline-group ${escapeHtml(g.kind)} ${escapeHtml(state.cls)}" data-agent-kind="phase" data-phase="${escapeHtml(label)}" data-group-id="${escapeHtml(g.id)}" ${open ? 'open' : ''}>
      <summary>
        <span class="timeline-group-marker">${escapeHtml(state.label)}</span>
        <span class="timeline-group-main">
          <span class="timeline-group-title">${escapeHtml(g.title)}</span>
          ${g.summary ? `<span class="timeline-group-summary">${escapeHtml(g.summary)}</span>` : ''}
          ${chips.length ? `<span class="timeline-group-meta">${chips.map((c) => `<span>${escapeHtml(c)}</span>`).join('')}</span>` : ''}
        </span>
        <span class="timeline-group-time">${escapeHtml(timeLabel(g.ts))}</span>
      </summary>
      <div class="timeline-group-body">
        ${renderGroupHighlights(g)}
      </div>
    </details>`;
}

function captureTimelineUiState() {
  if (!conversationEl) return null;
  return {
    scrollTop: conversationEl.scrollTop,
    openDetails: new Set([...conversationEl.querySelectorAll('.timeline-group details[data-detail-key][open]')].map((d) => {
      const group = d.closest('.timeline-group');
      return `${group?.dataset.groupId || ''}::${d.dataset.detailKey || ''}`;
    })),
  };
}

function restoreTimelineUiState(state, { preserveScroll = true } = {}) {
  if (!state || !conversationEl) return;
  requestAnimationFrame(() => {
    conversationEl.querySelectorAll('.timeline-group details[data-detail-key]').forEach((d) => {
      const group = d.closest('.timeline-group');
      const key = `${group?.dataset.groupId || ''}::${d.dataset.detailKey || ''}`;
      d.open = state.openDetails.has(key);
    });
    if (preserveScroll) conversationEl.scrollTop = state.scrollTop;
  });
}

function scrollTimelineToOpenGroup() {
  requestAnimationFrame(() => {
    const openGroups = [...(conversationEl?.querySelectorAll('.timeline-group[open]') || [])];
    const target = openGroups[openGroups.length - 1] || conversationEl?.querySelector('.timeline-group:last-child');
    if (!target || !conversationEl) return;
    const targetRect = target.getBoundingClientRect();
    const parentRect = conversationEl.getBoundingClientRect();
    const overview = conversationEl.querySelector('.timeline-overview');
    const overviewStyle = overview ? getComputedStyle(overview) : null;
    const stickyOffset = overviewStyle?.position === 'sticky' ? overview.getBoundingClientRect().height : 0;
    const top = Math.max(0, conversationEl.scrollTop + targetRect.top - parentRect.top - stickyOffset - 8);
    conversationEl.scrollTop = top;
  });
}

function renderTimeline(data = {}, { scrollLatest = false, uiState = null } = {}) {
  const blocks = data.blocks || [];
  if (!blocks.length) {
    conversationEl.innerHTML = '<div class="timeline-empty">No conversation timeline blocks yet.</div>';
    return;
  }
  const groups = buildTimelineGroups(blocks);
  conversationEl.innerHTML = `
    ${renderTimelineOverview(data, blocks, groups)}
    <div class="timeline-groups" data-agent-kind="narrative">
      ${groups.map(renderTimelineGroup).join('')}
    </div>`;
  if (uiState) restoreTimelineUiState(uiState, { preserveScroll: !scrollLatest });
  if (scrollLatest) scrollTimelineToOpenGroup();
}

conversationEl?.addEventListener('toggle', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLDetailsElement) || !target.classList.contains('timeline-group')) return;
  const gid = target.dataset.groupId;
  if (!gid) return;
  if (target.open) {
    timelineOpenGroups.add(gid);
    timelineClosedGroups.delete(gid);
  } else {
    timelineClosedGroups.add(gid);
    timelineOpenGroups.delete(gid);
  }
}, true);

async function loadTimeline() {
  if (!conversationEl) return;
  const firstLoad = !timelineLoaded;
  const uiState = firstLoad ? null : captureTimelineUiState();
  if (firstLoad) conversationEl.innerHTML = '<div class="timeline-empty">Loading conversation timeline…</div>';
  try {
    const data = await api(`api/session/${id}/timeline`);
    latestTimelineData = data;
    timelineLoaded = true;
    renderTimeline(data, { scrollLatest: firstLoad, uiState });
    if (latestMap && !latestMap?.map?.map) renderMap(latestMap);
  } catch (e) {
    conversationEl.innerHTML = `<div class="timeline-empty">Failed to load conversation timeline: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

// ---- header info ------------------------------------------------------------
const TITLE_ICON_EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"></path></svg>';
const TITLE_ICON_AI = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"></path><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"></path></svg>';
const TITLE_ICON_SAVE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>';
const TITLE_ICON_CANCEL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"></path><path d="M6 6l12 12"></path></svg>';
let titleEditing = false;
let titleBusy = false;
let latestSessionInfo = null;

function titleTags(s) {
  return [s.modelLabel, s.fastMode ? 'fast' : null, s.effort, s.autonomy].filter(Boolean).join(' · ');
}

function titleActionButton(id, html, label, extra = '') {
  return `<button class="btn ghost sm session-title-icon ${extra}" id="${id}" type="button" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${html}</button>`;
}

function renderHeaderTitle(s) {
  if (!s) return;
  latestSessionInfo = s;
  const el = $('#s-title');
  if (!el || titleEditing) return;
  const tags = titleTags(s);
  el.innerHTML = `
    <span class="session-title-wrap">
      <b>${escapeHtml(s.project?.name || '(adhoc)')}</b>
      <span class="session-title-value" id="session-title-value" role="button" tabindex="0" title="Rename session">${escapeHtml(s.title || '')}</span>
      <span class="session-title-actions">
        ${titleActionButton('session-title-edit', TITLE_ICON_EDIT, 'Rename session')}
        ${titleActionButton('session-title-ai', TITLE_ICON_AI, 'Summarize title with cheap model', titleBusy ? 'loading' : '')}
      </span>
      ${tags ? ` <span class="badge" title="model · effort · autonomy">${escapeHtml(tags)}</span>` : ''}
    </span>`;
  $('#session-title-edit')?.addEventListener('click', startTitleEdit);
  $('#session-title-ai')?.addEventListener('click', suggestAndApplyTitle);
  const value = $('#session-title-value');
  value?.addEventListener('click', startTitleEdit);
  value?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      startTitleEdit();
    }
  });
}

function applySessionInfo(s) {
  if (!s) return;
  const merged = latestSessionInfo
    ? { ...latestSessionInfo, ...s, project: s.project || latestSessionInfo.project }
    : s;
  latestSessionInfo = merged;
  if (merged.toolColor && merged.toolLabel) {
    $('#s-badge').innerHTML = `<span class="badge" style="border-color:${merged.toolColor}99;color:${merged.toolColor}">${merged.toolLabel}</span>`;
  }
  renderHeaderTitle(merged);
  const st = $('#s-status');
  if (st && merged.status) {
    st.textContent = merged.status;
    st.className = 'status-txt ' + merged.status;
  }
  const resume = $('#b-resume');
  if (resume && merged.status) resume.hidden = merged.status !== 'exited';
  setSessionBrowserIdentity(merged);
}

function startTitleEdit() {
  const s = latestSessionInfo;
  if (!s || titleBusy) return;
  titleEditing = true;
  const tags = titleTags(s);
  $('#s-title').innerHTML = `
    <span class="session-title-wrap editing">
      <b>${escapeHtml(s.project?.name || '(adhoc)')}</b>
      <input id="session-title-input" class="session-title-input" type="text" maxlength="90" value="${escapeHtml(s.title || '')}" aria-label="Session title" />
      <span class="session-title-actions">
        ${titleActionButton('session-title-save', TITLE_ICON_SAVE, 'Save title')}
        ${titleActionButton('session-title-cancel', TITLE_ICON_CANCEL, 'Cancel rename')}
      </span>
      ${tags ? ` <span class="badge" title="model · effort · autonomy">${escapeHtml(tags)}</span>` : ''}
    </span>`;
  const input = $('#session-title-input');
  input?.focus();
  input?.select();
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveTitle();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelTitleEdit();
    }
  });
  $('#session-title-save')?.addEventListener('click', saveTitle);
  $('#session-title-cancel')?.addEventListener('click', cancelTitleEdit);
}

function cancelTitleEdit() {
  titleEditing = false;
  if (latestSessionInfo) renderHeaderTitle(latestSessionInfo);
}

async function saveTitle() {
  const input = $('#session-title-input');
  const title = input?.value.trim();
  if (!title) {
    input?.focus();
    return;
  }
  titleBusy = true;
  try {
    const r = await api(`api/session/${id}/title`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, source: 'manual' }) });
    titleEditing = false;
    applySessionInfo(r.session);
    loadSessionRail();
  } catch (e) {
    input?.classList.add('error');
    input?.setAttribute('title', e.message || String(e));
  } finally {
    titleBusy = false;
    if (!titleEditing && latestSessionInfo) renderHeaderTitle(latestSessionInfo);
  }
}

async function suggestAndApplyTitle() {
  if (titleBusy || titleEditing || !latestSessionInfo) return;
  titleBusy = true;
  renderHeaderTitle(latestSessionInfo);
  try {
    const r = await api(`api/session/${id}/title/suggest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apply: true }) });
    applySessionInfo(r.session);
    loadSessionRail();
  } finally {
    titleBusy = false;
    if (latestSessionInfo) renderHeaderTitle(latestSessionInfo);
  }
}

async function loadInfo() {
  try {
    const s = await api(`api/session/${id}`);
    applySessionInfo(s);
  } catch {}
}
loadInfo();

// The agent host builds the side-panel tab bar + mounts agent panels. Map/Usage are driven as
// "legacy" panels via their existing loaders; Supervisor/Builder/drop-ins are panel modules.
agentPanel = initAgentPanel({
  sessionId: id,
  tabsEl: $('#side-tabs'),
  panelsEl: $('#side-panels'),
  legacy: { usage: { load: loadUsage } }, // map is now a real panel module (web/agents/map.js)
  onTabChange: () => setTimeout(syncSize, 80),
});

// Deferred like the terminal stream (see afterIdle) so the page reaches network-idle after load.
let events = null;
afterIdle(() => {
  events = new EventSource('api/events');
  events.addEventListener('session-status', (e) => {
    let payload = null;
    try {
      payload = JSON.parse(e.data || '{}');
    } catch {
      return;
    }
    if (payload?.session !== id || !payload.status) return;
    applySessionInfo(payload);
  });
  // 4 fetches per 'changed' × every poll tick of every agent = the dominant bandwidth
  // drain on relayed clients — coalesce to one round per 3s.
  events.addEventListener('changed', coalesce(() => {
  loadInfo();
  loadUsage();
  loadSessionRail();
  agentPanel?.refresh(); // agent tabs/dots + the active agent panel (supervisor verdict, etc.)
  if (activeMainView === 'conversation') loadTimeline();
  if (activeMainView === 'agent') loadAgentView({ refresh: true });
  if (activeMainView === 'scrollback') loadScrollback({ quiet: true });
    if (activeMainView === 'story') loadStoryView(); // story keeps up with the live session
  }, 3000));
});

// ---- usage / quota / limits -------------------------------------------------
function fmtTokens(v) {
  const n = Number(v || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 10e9 ? 1 : 2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 10e6 ? 1 : 2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 10e3 ? 1 : 2) + 'K';
  return String(Math.round(n));
}
function money(v) {
  const n = Number(v || 0);
  return '$' + n.toFixed(n >= 10 ? 2 : 4);
}
function percent(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(n >= 10 ? 0 : 1) + '%' : 'n/a';
}
function resetIn(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Number(ts) - Date.now()) / 1000));
  if (s < 60) return 'resets <1m';
  if (s < 3600) return `resets ${Math.round(s / 60)}m`;
  if (s < 86400) return `resets ${Math.round(s / 3600)}h`;
  return `resets ${Math.round(s / 86400)}d`;
}
function numValue(v) {
  return v == null || v === '' ? '' : String(v);
}
function millionTokenValue(v) {
  if (v == null || v === '') return '';
  const n = Number(v) / 1_000_000;
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : '';
}
function quotaBar(w) {
  const used = Math.max(0, Math.min(100, Number(w.usedPercent || 0)));
  const cls = used >= 90 ? 'hot' : used >= 70 ? 'warn' : '';
  return `
    <div class="quota-row">
      <div class="q-name">${escapeHtml(w.name)}</div>
      <div class="qbar ${cls}" title="${percent(used)} used"><span style="width:${used}%"></span></div>
      <div class="q-meta">${percent(used)} ${escapeHtml(resetIn(w.resetAt))}</div>
    </div>`;
}
function modelUsageRows(rows = [], currentModel = '') {
  const meaningful = rows.filter((r) => r && r.name);
  if (!meaningful.length) return '<div class="muted">No model-level usage recorded yet.</div>';
  return meaningful.map((r) => {
    const isCurrent = currentModel && r.name === currentModel;
    const traffic = Number(r.token_traffic_tokens || r.total_tokens || 0);
    return `
      <div class="model-usage-row ${isCurrent ? 'current' : ''}">
        <div class="model-usage-title">
          <span>${escapeHtml(r.name)}</span>
          ${isCurrent ? '<b>current</b>' : ''}
        </div>
        <div class="model-usage-meta">
          <span>${fmtTokens(traffic)} traffic</span>
          <span>${fmtTokens(r.total_tokens)} reported</span>
          <span>${Number(r.events || 0)} events</span>
          <span>${money(r.estimated_cost_usd)}</span>
        </div>
      </div>`;
  }).join('');
}
let latestUsage = null;
function renderUsage(d) {
  latestUsage = d;
  const box = $('#s-usage');
  const usage = d?.usage || {};
  const totals = usage.totals || {};
  const assoc = usage.association || {};
  const quota = d?.quota || {};
  const limit = d?.limit || {};
  const agyStatus = usage.statusline?.raw_json || null;
  const agyCtx = agyStatus?.context_window || null;
  const windows = quota.windows || [];
  const primary = windows.filter((w) => w.name === '5h' || w.name === 'weekly');
  const quotaWindowRows = (primary.length ? primary : windows.slice(0, 2)).map(quotaBar).join('');
  const contextRow = agyCtx && agyCtx.used_percentage != null
    ? quotaBar({ name: 'context', usedPercent: agyCtx.used_percentage })
    : '';
  const quotaRows = [quotaWindowRows, contextRow].filter(Boolean).join('') || '<div class="muted">No live quota feed for this tool.</div>';
  const quotaLabel = quota.label || (agyStatus?.plan_tier ? `Antigravity ${agyStatus.plan_tier}` : quota.provider || quota.tool || '');
  const quotaTitle = [quotaLabel, quota.modelLabel].filter(Boolean).join(' / ');
  const currentModel = d?.session?.model || usage.model || '';
  const currentModelLabel = d?.session?.modelLabel || currentModel || '(unknown)';
  const triggered = limit.triggered_at
    ? `<span class="limit-triggered">Stopped: ${escapeHtml(limit.triggered_reason || 'limit reached')}</span>`
    : limit.enabled
      ? 'Limit enforcement is active.'
      : 'Limits are saved per session and enforced server-side.';

  box.innerHTML = `
    <section class="su-card">
      <h2><span>Quota</span><span>${escapeHtml(quotaTitle)}</span></h2>
      <div class="quota-list">${quotaRows}</div>
      ${agyStatus && !windows.length ? '<div class="muted">AGY exposes context and plan status here; exact subscription quota windows are still not reported locally.</div>' : ''}
    </section>
    <section class="su-card">
      <h2><span>Current Session</span><span>${escapeHtml(currentModelLabel)}</span></h2>
      <div class="su-kpis">
        <div class="su-kpi"><b>${fmtTokens(totals.token_traffic_tokens)}</b><span>traffic</span></div>
        <div class="su-kpi"><b>${fmtTokens(totals.total_tokens)}</b><span>reported</span></div>
        <div class="su-kpi"><b>${fmtTokens(totals.cached_input_tokens)}</b><span>cached</span></div>
        <div class="su-kpi"><b>${money(totals.estimated_cost_usd)}</b><span>api equiv</span></div>
      </div>
      <div class="limit-note">${Number(assoc.exact_events || 0)} exact events · ${Number(assoc.inferred_events || 0)} inferred events · ${Number(totals.unpriced_events || 0)} unpriced</div>
    </section>
    <section class="su-card">
      <h2><span>Model History</span><span>${Number((usage.byModel || []).length)} models</span></h2>
      <div class="model-usage-list">${modelUsageRows(usage.byModel || [], currentModel)}</div>
    </section>
    <section class="su-card">
      <h2><span>Stop Limits</span><span>${triggered}</span></h2>
      <div class="limit-note limit-scope">Quota follows the current model. Dollar and token caps count this whole session, including previous models.</div>
      <form id="limit-form">
        <div class="limit-grid">
          <label>Quota %
            <input id="limit-weekly" type="number" min="1" max="100" step="1" inputmode="decimal" value="${escapeHtml(numValue(limit.weekly_limit_percent))}" placeholder="90" />
          </label>
          <label>Dollar cap
            <input id="limit-cost" type="number" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(numValue(limit.cost_limit_usd))}" placeholder="25.00" />
          </label>
          <label>Million tokens
            <input id="limit-tokens" type="number" min="0.001" step="0.1" inputmode="decimal" value="${escapeHtml(millionTokenValue(limit.token_limit_total))}" placeholder="50" />
          </label>
        </div>
        <div class="limit-actions">
          <label class="limit-enable"><input id="limit-enabled" type="checkbox" ${limit.enabled ? 'checked' : ''} /> enabled</label>
          <button class="btn sm" type="submit">Save</button>
          <button class="btn ghost sm" type="button" id="limit-clear">Clear</button>
          <span class="limit-note">Stops by sending Ctrl-C when any active limit is reached.</span>
        </div>
      </form>
    </section>`;

  const form = $('#limit-form');
  const readNum = (sel) => {
    const v = $(sel)?.value.trim();
    return v ? Number(v) : null;
  };
  const readMillionTokens = (sel) => {
    const v = readNum(sel);
    return v == null ? null : Math.round(v * 1_000_000);
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      renderUsage(await api(`api/session/${id}/limit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: $('#limit-enabled').checked,
          weekly_limit_percent: readNum('#limit-weekly'),
          cost_limit_usd: readNum('#limit-cost'),
          token_limit_total: readMillionTokens('#limit-tokens'),
        }),
      }));
    } catch (e) {
      alert('Limit update failed: ' + e.message);
    } finally {
      btn.disabled = false;
      syncSize();
    }
  };
  $('#limit-clear').onclick = async () => {
    try {
      renderUsage(await api(`api/session/${id}/limit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      }));
    } catch (e) {
      alert('Limit clear failed: ' + e.message);
    } finally {
      syncSize();
    }
  };
  setTimeout(syncSize, 80);
}
async function loadUsage() {
  if (isInteracting($('#s-usage'))) return; // shared guard: don't re-render while editing limits / interacting
  try {
    const d = await api(`api/session/${id}/usage`);
    if ($('#limit-form')?.contains(document.activeElement)) {
      latestUsage = d;
      return;
    }
    renderUsage(d);
  } catch {
    if (!latestUsage) $('#s-usage').innerHTML = '<section class="su-card"><span class="muted">Usage data unavailable.</span></section>';
  }
}
loadUsage();
setInterval(loadUsage, 30000);

// ---- session map ------------------------------------------------------------

function safeHtml(raw) {
  const allowed = new Set(['P', 'UL', 'OL', 'LI', 'STRONG', 'B', 'EM', 'I', 'CODE', 'PRE', 'BR']);
  const t = document.createElement('template');
  t.innerHTML = String(raw || '');
  const clean = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      clean(child);
      if (!allowed.has(child.tagName)) {
        child.replaceWith(document.createTextNode(child.textContent || ''));
        continue;
      }
      for (const attr of [...child.attributes]) child.removeAttribute(attr.name);
    }
  };
  clean(t.content);
  return t.innerHTML || '<p>No summary yet.</p>';
}

function textBlock(s) {
  return escapeHtml(s || '').replace(/\n/g, '<br>');
}

function listHtml(items, cls = '') {
  const arr = (items || []).filter(Boolean);
  if (!arr.length) return '<div class="muted">None recorded yet.</div>';
  return `<ul class="${cls}">` + arr.map((x) => `<li>${escapeHtml(x)}</li>`).join('') + '</ul>';
}

function optionHtml(items, selected) {
  return (items || []).map((o) => `<option value="${escapeHtml(o.id)}" ${o.id === selected ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
}

function fitSettingSelect(el) {
  const text = el?.options?.[el.selectedIndex]?.textContent || el?.value || '';
  const ch = Math.max(2, Math.min(54, String(text).length));
  el?.style.setProperty('--select-width', `${ch}ch`);
}

function timeLabel(ts) {
  if (!ts) return '';
  const t = Date.parse(ts) || Number(ts);
  if (!Number.isFinite(t)) return String(ts);
  return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function statusClass(s) {
  return String(s || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function changedPathsFromStatus(text = '') {
  return String(text || '').split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      const m = trimmed.match(/^(?:[ADMRCU?!]{1,2}|[MADRCU?! ]{1,2})\s+(.+)$/);
      return m?.[1]?.trim();
    })
    .filter(Boolean);
}

function changedPathsFromStat(text = '') {
  return String(text || '').split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^\s*(.+?)\s+\|\s+(\d+)/);
      return m ? { path: m[1].trim(), lines: Number(m[2]) || 0 } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.lines - a.lines)
    .map((x) => x.path);
}

function uniqueList(items = [], limit = 5) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const s = String(item || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

function isEvidenceSummary(text = '') {
  return /\b(changed paths?|terminal lines?|working tree|current project changes)\b/i.test(String(text || ''));
}

function renderAgentMapSnapshot(data = latestAgentData) {
  const groups = data?.groups || [];
  if (!groups.length) return '';
  const requestGroups = groups.filter((g) => g.kind === 'request');
  const selected = groups.find((g) => g.id === selectedAgentRequestId) || requestGroups.at(-1) || groups.at(-1);
  const session = data.session || {};
  const openAsks = groups.reduce((n, g) => n + Number(g.counts?.openDecisions || 0), 0);
  const changedFiles = selected?.artifacts?.filter((a) => a.kind === 'code-change').slice(0, 6) || [];
  const files = selected?.artifacts?.filter((a) => a.kind !== 'code-change').slice(0, 4) || [];
  const selectedCounts = selected?.counts || {};
  const latestChange = selected?.changes?.at(-1);
  const latestTerminal = selected?.terminal?.at(-1);
  const pendingDecisions = selected?.decisions?.filter((d) => d.status === 'pending') || [];
  const kpis = [
    [requestGroups.length, 'Requests'],
    [groups.reduce((n, g) => n + Number(g.counts?.artifacts || 0), 0), 'Artifacts'],
    [groups.reduce((n, g) => n + Number(g.counts?.changeSets || 0), 0), 'Change sets'],
    [openAsks, 'Open asks'],
  ];
  return `
    <div class="map-snapshot agent-map-snapshot">
      <div class="map-meta">
        <span class="map-state ${statusClass(session.status)}">${escapeHtml(session.status || 'live')}</span>
        <span>${escapeHtml(session.toolLabel || session.tool || '')}${session.modelLabel || session.model ? ` · ${escapeHtml(session.modelLabel || session.model)}` : ''}</span>
      </div>
      <div class="map-snapshot-kpis">
        ${kpis.map(([value, label]) => `<span><b>${escapeHtml(value)}</b>${escapeHtml(label)}</span>`).join('')}
      </div>
      ${selected ? `
        <div class="map-snapshot-latest">
          <span>Selected request</span>
          <b>${escapeHtml(compactText(selected.title, 120))}</b>
          ${selected.summary ? `<p>${escapeHtml(compactText(selected.summary, 180))}</p>` : ''}
        </div>` : ''}
      ${selected ? `
        <div class="map-snapshot-latest">
          <span>Request evidence</span>
          <p>${escapeHtml([
            selectedCounts.changedFiles ? `${selectedCounts.changedFiles} changed files` : '',
            selectedCounts.terminal ? `${selectedCounts.terminal} terminal section` : '',
            selectedCounts.decisions ? `${selectedCounts.decisions} decisions` : '',
          ].filter(Boolean).join(' · ') || 'No extra evidence yet')}</p>
          ${latestChange?.summary ? `<p>${escapeHtml(compactText(latestChange.summary, 170))}</p>` : ''}
          ${latestTerminal?.summary ? `<p>${escapeHtml(compactText(latestTerminal.summary, 150))}</p>` : ''}
        </div>` : ''}
      ${pendingDecisions.length ? `
        <div class="map-snapshot-latest">
          <span>Needs input</span>
          ${pendingDecisions.slice(0, 2).map((d) => `<p>${escapeHtml(compactText(d.summary || d.ask, 160))}</p>`).join('')}
        </div>` : ''}
      ${changedFiles.length ? `
        <div class="map-snapshot-latest">
          <span>Changed files</span>
          <div class="map-path-list">${changedFiles.map((f) => `<code>${escapeHtml(f.path || f.title)}</code>`).join('')}</div>
        </div>` : ''}
      ${files.length ? `
        <div class="map-snapshot-latest">
          <span>Artifacts</span>
          <div class="map-path-list">${files.map((f) => `<code>${escapeHtml(f.title || f.path || f.format)}</code>`).join('')}</div>
        </div>` : ''}
    </div>`;
}

function renderLiveMapSnapshot(data = latestTimelineData) {
  if (activeMainView === 'agent' && latestAgentData?.groups?.length) return renderAgentMapSnapshot(latestAgentData);
  const blocks = data?.blocks || [];
  if (!blocks.length) return '';
  const groups = buildTimelineGroups(blocks);
  const requestGroups = groups.filter((g) => g.kind === 'request');
  const latestRequest = [...requestGroups].pop();
  const stats = data.stats || {};
  const pendingBlocks = blocks.filter((b) => b.type === 'decision' && b.status === 'pending');
  const pending = pendingBlocks.length;
  const session = data.session || {};
  const latestDiff = [...blocks].reverse().find((b) => b.type === 'diff');
  const latestActivity = [...blocks].reverse().find((b) => b.type === 'event' && b.subtype !== 'session');
  const recentCheckpoints = blocks
    .filter((b) => b.type === 'decision' && b.summary)
    .slice(-2);
  const workingPaths = latestDiff
    ? uniqueList([...changedPathsFromStat(latestDiff.stat), ...changedPathsFromStatus(latestDiff.status)], 5)
    : [];
  const kpis = [
    [requestGroups.length || stats.messages || 0, 'Requests'],
    [stats.attachments || 0, 'Files'],
    [stats.diffs || 0, 'Change sets'],
    [pending, 'Open asks'],
  ];
  const latestSummary = latestRequest?.summary || latestActivity?.summary || '';
  return `
    <div class="map-snapshot">
      <div class="map-meta">
        <span class="map-state ${statusClass(session.status)}">${escapeHtml(session.status || 'live')}</span>
        <span>${escapeHtml(session.toolLabel || session.tool || '')}${session.modelLabel || session.model ? ` · ${escapeHtml(session.modelLabel || session.model)}` : ''}</span>
      </div>
      <div class="map-snapshot-kpis">
        ${kpis.map(([value, label]) => `<span><b>${escapeHtml(value)}</b>${escapeHtml(label)}</span>`).join('')}
      </div>
      ${latestRequest ? `
        <div class="map-snapshot-latest">
          <span>Latest request</span>
          <b>${escapeHtml(compactText(latestRequest.title, 120))}</b>
          ${latestSummary && latestSummary !== latestRequest.title && !isEvidenceSummary(latestSummary) ? `<p>${escapeHtml(compactText(latestSummary, 180))}</p>` : ''}
        </div>` : ''}
      ${pendingBlocks.length ? `
        <div class="map-snapshot-latest">
          <span>Needs input</span>
          ${pendingBlocks.slice(-2).map((b) => `<p>${escapeHtml(compactText(b.summary || b.ask || b.question, 160))}</p>`).join('')}
        </div>` : ''}
      ${latestDiff ? `
        <div class="map-snapshot-latest">
          <span>Working tree</span>
          <p>${escapeHtml(compactText(latestDiff.summary || latestDiff.stat, 180))}</p>
          ${workingPaths.length ? `<div class="map-path-list">${workingPaths.map((p) => `<code>${escapeHtml(p)}</code>`).join('')}</div>` : ''}
        </div>` : ''}
      ${recentCheckpoints.length ? `
        <div class="map-snapshot-latest">
          <span>Recent checkpoints</span>
          ${recentCheckpoints.map((b) => `<p>${escapeHtml(compactText(b.summary, 150))}</p>`).join('')}
        </div>` : ''}
    </div>`;
}

function renderMap(payload) {
  latestMap = payload;
  const box = $('#s-map');
  const data = payload?.map;
  const options = payload?.options || {};
  const map = data?.map;
  const genDefault = localStorage.getItem(PREF_MAP_GENERATE_TARGET) || options.defaults?.generate || options.targets?.generate?.[0]?.id || '';
  const updDefault = localStorage.getItem(PREF_MAP_UPDATE_TARGET) || options.defaults?.update || options.targets?.update?.[0]?.id || '';
  const controls = `
    <details class="map-action-drawer">
      <summary>Narrative map</summary>
      <div class="map-controls">
        <label>Generate
          <select id="map-generate-target">${optionHtml(options.targets?.generate, genDefault)}</select>
        </label>
        <button class="btn sm" id="map-generate" ${mapBusy ? 'disabled' : ''}>Generate</button>
        <label>Update
          <select id="map-update-target">${optionHtml(options.targets?.update, updDefault)}</select>
        </label>
        <button class="btn ghost sm" id="map-update" ${mapBusy ? 'disabled' : ''}>Update</button>
      </div>
    </details>`;

  if (!data || !map) {
    box.innerHTML = `
      <section class="map-card">
        <h2><span>Session Map</span><span>${mapBusy ? 'working...' : 'live snapshot'}</span></h2>
        ${renderLiveMapSnapshot()}
        ${controls}
        ${data?.error ? `<div class="map-error">${escapeHtml(data.error)}</div>` : ''}
      </section>`;
    wireMapControls();
    return;
  }

  const steps = map.timeline_steps || [];
  box.innerHTML = `
    <section class="map-card map-hero">
      <h2><span>Session Map</span><span>${escapeHtml(data.model || '')}</span></h2>
      <h3>${escapeHtml(map.headline || 'Session map')}</h3>
      <div class="map-meta">
        <span class="map-state ${statusClass(map.current_state)}">${escapeHtml(map.current_state || 'unknown')}</span>
        <span>Updated ${timeLabel(data.updated_at)}</span>
      </div>
      <div class="map-summary">${safeHtml(map.human_summary_html)}</div>
      ${controls}
      ${data.error ? `<div class="map-error">${escapeHtml(data.error)}</div>` : ''}
    </section>
    <section class="map-card">
      <h2><span>Understanding</span></h2>
      <p>${textBlock(map.user_request_understanding)}</p>
    </section>
    <section class="map-card">
      <h2><span>Project Context</span></h2>
      <p>${textBlock(map.project_context)}</p>
    </section>
    <section class="map-card">
      <h2><span>Steps</span><span>${steps.length}</span></h2>
      <div class="map-steps">
        ${steps.map((step, i) => `
          <details class="map-step" ${i < 2 ? 'open' : ''}>
            <summary>
              <span class="map-step-title">${escapeHtml(step.title || 'Step')}</span>
              <span class="map-step-status ${statusClass(step.status)}">${escapeHtml(step.status || 'unknown')}</span>
              <span class="map-step-meta">${escapeHtml(step.elapsed || '')} · ${fmtTokens(step.token_traffic)} traffic · ${money(step.estimated_cost_usd)}</span>
            </summary>
            <p>${textBlock(step.summary)}</p>
            ${step.start_time || step.end_time ? `<div class="map-step-time">${escapeHtml(timeLabel(step.start_time))}${step.end_time ? ' - ' + escapeHtml(timeLabel(step.end_time)) : ''}</div>` : ''}
            ${step.details_html ? `<div class="map-step-detail">${safeHtml(step.details_html)}</div>` : ''}
            <div class="map-confidence">Confidence: ${escapeHtml(step.confidence || 'medium')}</div>
          </details>`).join('')}
      </div>
    </section>
    <section class="map-card map-two">
      <div>
        <h2><span>Decisions</span></h2>
        ${listHtml(map.decisions_and_assumptions)}
      </div>
      <div>
        <h2><span>Artifacts</span></h2>
        ${listHtml(map.artifacts_changed)}
      </div>
    </section>
    <section class="map-card">
      <h2><span>Watchouts</span></h2>
      ${listHtml(map.risks_or_watchouts)}
    </section>
    <section class="map-card">
      <h2><span>Get Involved</span></h2>
      <p>${textBlock(map.how_to_get_involved_now)}</p>
    </section>
    <section class="map-card">
      <h2><span>Long-Term Vision</span></h2>
      <p>${textBlock(map.long_term_vision)}</p>
    </section>
    <section class="map-card">
      <h2><span>Next Actions</span></h2>
      ${listHtml(map.next_best_actions)}
    </section>`;
  wireMapControls();
}

function wireMapControls() {
  const genSel = $('#map-generate-target');
  const updSel = $('#map-update-target');
  if (genSel) genSel.onchange = () => localStorage.setItem(PREF_MAP_GENERATE_TARGET, genSel.value);
  if (updSel) updSel.onchange = () => localStorage.setItem(PREF_MAP_UPDATE_TARGET, updSel.value);
  const run = async (mode) => {
    mapBusy = true;
    renderMap(latestMap || { options: {} });
    try {
      const target = mode === 'update' ? $('#map-update-target')?.value : $('#map-generate-target')?.value;
      if (target) localStorage.setItem(mode === 'update' ? PREF_MAP_UPDATE_TARGET : PREF_MAP_GENERATE_TARGET, target);
      const r = await api(`api/session/${id}/map`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, target }),
      });
      renderMap(r);
    } catch (e) {
      alert('Map generation failed: ' + e.message);
    } finally {
      mapBusy = false;
      loadMap();
    }
  };
  const gen = $('#map-generate');
  const upd = $('#map-update');
  if (gen) gen.onclick = () => run('generate');
  if (upd) upd.onclick = () => run('update');
}

async function loadMap() {
  try {
    renderMap(await api(`api/session/${id}/map`));
  } catch {
    if (!latestMap) $('#s-map').innerHTML = '<section class="map-card"><span class="muted">Session map unavailable.</span></section>';
  }
}
loadMap();


// ---- on-the-fly settings (autonomy / effort / model) ------------------------
function renderSettings(s, tmeta) {
  const box = $('#s-settings');
  const sel = (label, key, options, cur) =>
    `<label class="setting setting-select setting-${escapeHtml(key)}"><select data-set="${key}" aria-label="${escapeHtml(label)}">` +
    options.map((o) => `<option value="${escapeHtml(o.v)}" ${o.v === cur ? 'selected' : ''}>${escapeHtml(o.l)}</option>`).join('') +
    `</select></label>`;
  const toggle = (label, key, on) =>
    `<button class="setting setting-toggle setting-${escapeHtml(key)} ${on ? 'on' : ''}" type="button" data-toggle="${key}" aria-pressed="${on ? 'true' : 'false'}" aria-label="${escapeHtml(label)}">${escapeHtml(label)}</button>`;
  let html = sel('Permissions', 'autonomy', ['ask', 'auto', 'full'].map((v) => ({ v, l: v })), s.autonomy);
  if ((tmeta.efforts || []).length) html += sel('Effort', 'effort', tmeta.efforts.map((v) => ({ v, l: v })), s.effort);
  const activeModel = s.model || tmeta.model;
  const activeModelMeta = (tmeta.models || []).find((m) => m.id === activeModel);
  if ((tmeta.models || []).length > 1) {
    const models = tmeta.models.map((m) => ({ v: m.id, l: m.label }));
    if (s.model && !models.some((m) => m.v === s.model)) models.unshift({ v: s.model, l: s.model });
    html += sel('Model', 'model', models, s.model);
  }
  if (s.tool === 'codex' && (s.fastCapable || activeModelMeta?.supportsFast)) html += toggle('fast', 'fastMode', !!s.fastMode);
  if ((tmeta.orchestrations || []).length) html += sel('Orchestration', 'orchestration', tmeta.orchestrations.map((v) => ({ v, l: v })), s.orchestration || 'off');
  box.innerHTML = html;
  box.querySelectorAll('select[data-set]').forEach((el) => {
    fitSettingSelect(el);
    const wrap = el.closest('.setting-select');
    if (wrap) {
      wrap.onclick = (e) => {
        if (e.target === el) return;
        e.preventDefault();
        el.focus();
        try {
          if (typeof el.showPicker === 'function') el.showPicker();
          else el.click();
        } catch {}
      };
    }
    el.onchange = async () => {
      fitSettingSelect(el);
      el.disabled = true;
      try {
        const r = await api(`api/session/${id}/settings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [el.dataset.set]: el.value }),
        });
        if (r.applied === 'relaunched') setTimeout(() => location.reload(), 1000);
      } catch (e) {
        alert('Update failed: ' + e.message);
      } finally {
        el.disabled = false;
      }
    };
  });
  box.querySelectorAll('button[data-toggle]').forEach((el) => {
    el.onclick = async () => {
      const next = el.getAttribute('aria-pressed') !== 'true';
      el.disabled = true;
      try {
        const r = await api(`api/session/${id}/settings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [el.dataset.toggle]: next }),
        });
        el.setAttribute('aria-pressed', next ? 'true' : 'false');
        el.classList.toggle('on', next);
        if (r.applied === 'relaunched') setTimeout(() => location.reload(), 1000);
      } catch (e) {
        alert('Update failed: ' + e.message);
      } finally {
        el.disabled = false;
      }
    };
  });
}
(async () => {
  try {
    const s = await api(`api/session/${id}`);
    const st = await api('api/state');
    renderSettings(s, (st.tools || []).find((t) => t.id === s.tool) || {});
  } catch {}
})();

// ---- reply composer ---------------------------------------------------------
// Stopped-session send: an inline bar over the composer offers Resume (no native confirm dialog).
function showResumeBar() {
  if (document.getElementById('resume-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'resume-bar';
  bar.className = 'pm-boundary resume-bar';
  bar.innerHTML = `<span>This session has stopped — resume it, then send again once it reloads.</span>
    <button class="btn sm" id="resume-bar-go">Resume</button>
    <button class="btn ghost sm" id="resume-bar-x">Dismiss</button>`;
  const anchorEl = reply.closest('form') || reply.parentElement;
  anchorEl.parentElement.insertBefore(bar, anchorEl);
  bar.querySelector('#resume-bar-x').onclick = () => bar.remove();
  bar.querySelector('#resume-bar-go').onclick = async () => {
    bar.querySelector('#resume-bar-go').disabled = true;
    try {
      await api(`api/session/${id}/resume`, { method: 'POST' });
      bar.querySelector('span').textContent = 'Resuming — reloading…';
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      bar.querySelector('span').textContent = 'Resume failed: ' + (e.message || e);
      bar.querySelector('#resume-bar-go').disabled = false;
    }
  };
}
const reply = $('#reply');
const replyFullPlaceholder = reply.getAttribute('placeholder') || '';
const sendBtn = $('#send');
const micBtn = $('#mic');
const attachBtns = [...document.querySelectorAll('.attach-btn')];
const fileInput = $('#file-input');
const messageBox = $('#message-box');
const attachmentBox = $('#attachments');
const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;
let attachments = [];
let attachmentSeq = 0;

attachBtns.forEach((btn) => {
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';
});
sendBtn.innerHTML =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return Math.max(0, n) + ' B';
}

function fileFormat(name, type = '') {
  const ext = String(name || '').split('.').pop();
  if (ext && ext !== name) return ext.toUpperCase().slice(0, 12);
  const mime = String(type || '').split(';')[0].toLowerCase();
  const byMime = {
    'image/jpeg': 'JPG',
    'image/png': 'PNG',
    'image/gif': 'GIF',
    'image/webp': 'WEBP',
    'image/svg+xml': 'SVG',
    'application/pdf': 'PDF',
    'application/json': 'JSON',
    'text/plain': 'TXT',
    'text/csv': 'CSV',
    'text/markdown': 'MD',
    'audio/mpeg': 'MP3',
    'audio/ogg': 'OGG',
    'audio/opus': 'OPUS',
    'audio/wav': 'WAV',
    'video/mp4': 'MP4',
    'application/zip': 'ZIP',
  };
  if (byMime[mime]) return byMime[mime];
  return mime.split('/')[1]?.toUpperCase().slice(0, 12) || 'FILE';
}

function isImageFile(file) {
  return String(file.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name || '');
}

function isTextFile(file) {
  const type = String(file.type || '').split(';')[0].toLowerCase();
  return type.startsWith('text/') || type === 'application/json' || /\.(txt|md|markdown|json|csv|log|yaml|yml)$/i.test(file.name || '');
}

function compactPreviewText(text, max = 360) {
  return String(text || '').replace(/\r/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function assetBadge(a) {
  if (a.sourceLabel === 'pasted' || /^pasted-/i.test(a.name || '')) return 'PASTED';
  return String(a.format || (a.isImage ? 'IMG' : 'FILE')).toUpperCase().slice(0, 12);
}

function readyAttachments() {
  return attachments.filter((a) => a.status === 'ready' && a.path);
}

function uploadsPending() {
  return attachments.some((a) => a.status === 'uploading');
}

function updateSendState() {
  sendBtn.disabled = uploadsPending() || (!reply.value.trim() && !readyAttachments().length);
}

function autoExpandReply() {
  reply.style.height = 'auto';
  reply.style.height = Math.max(42, reply.scrollHeight) + 'px';
  updateSendState();
  clearTimeout(rzTimer);
  rzTimer = setTimeout(syncSize, 80);
}

const compactComposerQuery = matchMedia('(max-width: 600px)');
function syncReplyPlaceholder() {
  const next = compactComposerQuery.matches ? 'Ask anything...' : replyFullPlaceholder;
  if (reply.getAttribute('placeholder') !== next) reply.setAttribute('placeholder', next);
  autoExpandReply();
}

function cleanupAttachment(a) {
  if (a?.previewUrl) URL.revokeObjectURL(a.previewUrl);
}

function renderAttachments() {
  attachmentBox.hidden = !attachments.length;
  attachmentBox.innerHTML = attachments.map((a) => {
    const status =
      a.status === 'uploading'
        ? 'Uploading'
        : a.status === 'error'
          ? 'Failed'
          : `${escapeHtml(a.format)} · ${formatBytes(a.size)}`;
    const title = a.name || 'attachment';
    const visual = a.isImage
      ? `<img class="asset-card-image" src="${escapeHtml(a.previewUrl || '')}" alt="${escapeHtml(title)}" />`
      : `<div class="asset-card-text">${escapeHtml(a.previewText || title)}</div>`;
    return `
      <div class="asset-card attachment-chip ${a.status}" data-attachment-id="${a.localId}">
        <button class="asset-card-open" type="button" data-attachment-open="${a.localId}" aria-label="Open ${escapeHtml(title)} details">
          <div class="asset-card-preview ${a.isImage ? 'image' : 'text'}">${visual}</div>
          <div class="asset-card-badge">${escapeHtml(assetBadge(a))}</div>
          <div class="asset-card-name">${escapeHtml(a.name)}</div>
          <div class="asset-card-meta">${status}${a.error ? ` · ${escapeHtml(a.error)}` : ''}</div>
        </button>
        <div class="asset-card-actions">
          <button class="btn ghost sm" type="button" data-attachment-open="${a.localId}">Details</button>
          <button class="attachment-remove btn ghost sm" type="button" aria-label="Remove ${escapeHtml(a.name)}">Remove</button>
        </div>
      </div>`;
  }).join('');
  attachmentBox.querySelectorAll('[data-attachment-open]').forEach((btn) => {
    btn.onclick = () => {
      const localId = btn.dataset.attachmentOpen;
      const a = attachments.find((x) => x.localId === localId);
      openComposerAttachmentDetail(a);
    };
  });
  attachmentBox.querySelectorAll('.attachment-remove').forEach((btn) => {
    btn.onclick = () => {
      const chip = btn.closest('[data-attachment-id]');
      const localId = chip?.dataset.attachmentId;
      const a = attachments.find((x) => x.localId === localId);
      cleanupAttachment(a);
      attachments = attachments.filter((x) => x.localId !== localId);
      renderAttachments();
    };
  });
  autoExpandReply();
}

function metaRows(rows) {
  return rows.filter(([, v]) => v != null && String(v) !== '').map(([k, v]) => `<div><span>${escapeHtml(k)}</span><code>${escapeHtml(v)}</code></div>`).join('');
}

function openComposerAttachmentDetail(a) {
  if (!a) return;
  const body = a.isImage && a.previewUrl
    ? `<img class="asset-detail-image" src="${escapeHtml(a.previewUrl)}" alt="${escapeHtml(a.name || 'attachment')}" />`
    : `<pre class="asset-detail-text">${escapeHtml(a.detailText || a.previewText || '')}</pre>`;
  const overlay = document.createElement('div');
  overlay.className = 'asset-detail-backdrop';
  overlay.innerHTML = `
    <div class="asset-detail" role="dialog" aria-modal="true" aria-label="${escapeHtml(a.name || 'Attachment')}">
      <button class="asset-detail-close" type="button" aria-label="Close">×</button>
      <h3>${escapeHtml(a.sourceLabel === 'pasted' ? 'Pasted content' : (a.name || 'Attachment'))}</h3>
      <div class="asset-detail-sub">${escapeHtml([formatBytes(a.size), a.lineCount ? `${a.lineCount} lines` : '', a.status].filter(Boolean).join(' · '))}</div>
      <div class="asset-detail-body">${body}</div>
      <div class="asset-detail-meta">${metaRows([
        ['local id', a.localId],
        ['name', a.name],
        ['type', a.type],
        ['format', a.format],
        ['size', formatBytes(a.size)],
        ['lines', a.lineCount || ''],
        ['status', a.status],
        ['stored path', a.path],
        ['source', a.sourceLabel],
        ['error', a.error],
      ])}</div>
    </div>`;
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('.asset-detail-close').onclick = close;
  document.body.appendChild(overlay);
}

// --- click a file path in the terminal to see what the agent wrote -------------------------------
// The agent prints paths like "docs/specs/foo.md" but there's no way to read them from here. Make
// path-like tokens in the terminal clickable -> a viewer modal backed by the project-root-confined
// GET /api/session/:id/file. Reuses the same asset-detail modal as attachments; content is untrusted so
// it's rendered as escaped text (never HTML). Also drives the Knowledge "Files" list via the same viewer.
const FILE_TOKEN_RX = /[\w./@~+-]*\w\.[A-Za-z0-9]{1,10}/g;
const FILE_TOKEN_EXTS = new Set(['md','markdown','txt','text','json','jsonc','yml','yaml','toml','ini','env','js','mjs','cjs','ts','tsx','jsx','py','go','rs','rb','java','kt','c','h','cc','cpp','hpp','cs','php','swift','css','scss','less','html','htm','xml','vue','svelte','sh','bash','zsh','sql','csv','tsv','log','svg','lock','png','jpg','jpeg','gif','webp','pdf']);
function cleanFileToken(t) {
  return String(t || '').replace(/^[('"`\[<{]+/, '').replace(/[)'"`\]>}.,;:]+$/, '').trim();
}
function looksLikeFile(raw) {
  if (!raw || raw.includes('://')) return false;
  const ext = (raw.split('.').pop() || '').toLowerCase();
  return raw.includes('/') || FILE_TOKEN_EXTS.has(ext);
}
let fileViewerBusy = false;
async function openFileViewer(rawPath) {
  const rel = cleanFileToken(rawPath);
  if (!rel || fileViewerBusy) return;
  fileViewerBusy = true;
  let meta = null;
  let errText = '';
  try {
    const r = await fetch(`api/session/${id}/file?path=${encodeURIComponent(rel)}`);
    if (r.ok) meta = await r.json();
    else errText = r.status === 403 ? 'That path is outside the project root.' : r.status === 404 ? 'File not found (the agent may not have written it yet, or it lives in another repo).' : `Could not open (HTTP ${r.status}).`;
  } catch { errText = 'Could not reach the server.'; }
  fileViewerBusy = false;
  // Text files get a toolbar: markdown renders as a PREVIEW by default (raw on toggle), any text can
  // be copied, everything can go fullscreen or be downloaded. Content stays untrusted: preview goes
  // through common.js renderMarkdown (escape-first, safe hrefs only), raw stays escaped <pre>.
  let body;
  let text = '';
  const isText = meta && !meta.binary && meta.contentKind !== 'image' && meta.contentKind !== 'pdf';
  const isMd = isText && /\.(md|markdown)$/i.test(meta.path || rel);
  const truncNote = meta?.truncated ? '\n\n… (truncated at 2 MB — download for the full file)' : '';
  if (!meta) body = `<pre class="asset-detail-text">${escapeHtml(errText)}</pre>`;
  else if (meta.contentKind === 'image') body = `<img class="asset-detail-image" src="${escapeHtml(meta.viewUrl)}" alt="${escapeHtml(meta.path)}" />`;
  else if (meta.contentKind === 'pdf') body = `<div class="asset-detail-file"><a href="${escapeHtml(meta.viewUrl)}" target="_blank" rel="noopener">Open PDF</a> · <a href="${escapeHtml(meta.downloadUrl)}" download>Download</a></div>`;
  else if (meta.binary) body = `<div class="asset-detail-file">Binary file — <a href="${escapeHtml(meta.downloadUrl)}" download>Download ${escapeHtml(meta.name)}</a></div>`;
  else {
    try { text = await fetch(meta.viewUrl).then((x) => (x.ok ? x.text() : '')); } catch {}
    body = isMd
      ? `<div class="md-view">${renderMarkdown(text)}${meta.truncated ? '<p class="count">… (truncated at 2 MB — download for the full file)</p>' : ''}</div>`
      : `<pre class="asset-detail-text">${escapeHtml(text)}${escapeHtml(truncNote)}</pre>`;
  }
  const title = meta ? meta.path : rel;
  const toolbar = !meta ? '' : `
    <div class="file-toolbar">
      ${isMd ? `<button class="btn ghost sm on" type="button" data-fv="preview">Preview</button><button class="btn ghost sm" type="button" data-fv="raw">Raw</button>` : ''}
      ${isText ? `<button class="btn ghost sm" type="button" data-fv="copy">Copy</button>` : ''}
      <button class="btn ghost sm" type="button" data-fv="full" title="Fullscreen reading">⛶ Fullscreen</button>
      <a class="btn ghost sm" href="${escapeHtml(meta.downloadUrl)}" download>Download</a>
      <span class="count" data-fv="msg"></span>
    </div>`;
  const overlay = document.createElement('div');
  overlay.className = 'asset-detail-backdrop';
  overlay.innerHTML = `
    <div class="asset-detail" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <button class="asset-detail-close" type="button" aria-label="Close">×</button>
      <h3>${escapeHtml(title)}</h3>
      ${meta ? `<div class="asset-detail-sub">${escapeHtml([formatBytes(meta.bytes), meta.contentKind].filter(Boolean).join(' · '))}</div>` : ''}
      ${toolbar}
      <div class="asset-detail-body">${body}</div>
      ${meta ? `<div class="asset-detail-meta">${metaRows([['path', meta.path], ['size', formatBytes(meta.bytes)], ['download', `${meta.name}`]])}</div>` : ''}
    </div>`;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('.asset-detail-close').onclick = close;
  const detail = overlay.querySelector('.asset-detail');
  const bodyEl = overlay.querySelector('.asset-detail-body');
  const msgEl = overlay.querySelector('[data-fv="msg"]');
  const setMode = (mode) => {
    bodyEl.innerHTML = mode === 'preview'
      ? `<div class="md-view">${renderMarkdown(text)}</div>`
      : `<pre class="asset-detail-text">${escapeHtml(text)}${escapeHtml(truncNote)}</pre>`;
    for (const b of overlay.querySelectorAll('[data-fv="preview"],[data-fv="raw"]')) b.classList.toggle('on', b.dataset.fv === mode);
  };
  overlay.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-fv]')?.dataset.fv;
    if (!act || act === 'msg') return;
    if (act === 'preview' || act === 'raw') return setMode(act);
    if (act === 'copy') {
      try { await navigator.clipboard.writeText(text); if (msgEl) msgEl.textContent = '✓ copied'; } catch { if (msgEl) msgEl.textContent = 'copy failed — select manually'; }
      setTimeout(() => { if (msgEl) msgEl.textContent = ''; }, 2000);
      return;
    }
    if (act === 'full') detail.classList.toggle('full');
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
}
// Let other panels (e.g. Knowledge "Files") open a file in this same viewer.
window.addEventListener('aios:open-file', (e) => { if (e.detail?.path) openFileViewer(e.detail.path); });

// Underline path-like tokens in the terminal and open the viewer on click. Works on the alt screen too.
if (typeof term.registerLinkProvider === 'function') {
  term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      let line;
      try { line = term.buffer.active.getLine(bufferLineNumber - 1); } catch { return callback(undefined); }
      if (!line) return callback(undefined);
      const text = line.translateToString(true);
      const links = [];
      let m;
      FILE_TOKEN_RX.lastIndex = 0;
      while ((m = FILE_TOKEN_RX.exec(text))) {
        const raw = m[0];
        if (!looksLikeFile(cleanFileToken(raw))) continue;
        links.push({
          range: { start: { x: m.index + 1, y: bufferLineNumber }, end: { x: m.index + raw.length, y: bufferLineNumber } },
          text: raw,
          activate: (ev) => { try { ev.preventDefault(); } catch {} openFileViewer(raw); },
        });
      }
      callback(links.length ? links : undefined);
    },
  });
}

function fileToDataBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('file read failed'));
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.readAsDataURL(file);
  });
}

async function uploadAttachment(item, file) {
  try {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`max ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB`);
    }
    const dataBase64 = await fileToDataBase64(file);
    const r = await api(`api/session/${id}/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: file.name || item.name,
        type: file.type || item.type,
        size: file.size,
        data_base64: dataBase64,
      }),
    });
    Object.assign(item, r.attachment || {}, { status: 'ready', error: '' });
  } catch (e) {
    item.status = 'error';
    item.error = e.message || 'upload failed';
  } finally {
    renderAttachments();
  }
}

async function fillTextPreview(item, file) {
  if (!isTextFile(file)) return;
  try {
    const text = await file.text();
    item.previewText = compactPreviewText(text);
    item.detailText = text.length > 600000 ? text.slice(0, 600000) + '\n\n[truncated for preview]' : text;
    item.lineCount = text ? text.split(/\r\n|\r|\n/).length : 0;
    renderAttachments();
  } catch {}
}

function addFiles(fileList, opts = {}) {
  const files = [...(fileList || [])].filter((f) => f && f.size >= 0);
  if (!files.length) return;
  for (const file of files) {
    if (attachments.length >= MAX_ATTACHMENTS) {
      alert(`Attachment limit is ${MAX_ATTACHMENTS} files.`);
      break;
    }
    const item = {
      localId: `local-${++attachmentSeq}`,
      name: file.name || `pasted-image-${attachmentSeq}.png`,
      type: file.type || '',
      size: file.size || 0,
      format: fileFormat(file.name, file.type),
      isImage: isImageFile(file),
      previewUrl: isImageFile(file) ? URL.createObjectURL(file) : '',
      previewText: '',
      detailText: '',
      lineCount: 0,
      sourceLabel: opts.source === 'paste' ? 'pasted' : '',
      status: 'uploading',
      path: '',
      error: '',
    };
    attachments.push(item);
    fillTextPreview(item, file);
    uploadAttachment(item, file);
  }
  renderAttachments();
}

function clearAttachments() {
  attachments.forEach(cleanupAttachment);
  attachments = [];
  renderAttachments();
}

function hasFilePayload(e) {
  const dt = e.clipboardData || e.dataTransfer;
  return [...(dt?.items || [])].some((item) => item.kind === 'file') || (dt?.files?.length || 0) > 0;
}

function filesFromTransfer(dt) {
  const itemFiles = [...(dt?.items || [])]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean);
  return itemFiles.length ? itemFiles : [...(dt?.files || [])];
}

function hasReferencePayload(e) {
  const types = [...(e?.dataTransfer?.types || [])];
  return types.includes('application/x-aios-reference');
}

function referenceFromTransfer(dt) {
  return dt?.getData('application/x-aios-reference') || '';
}

function insertComposerReference(text) {
  const ref = String(text || '').trim();
  if (!ref) return;
  histIdx = null;
  const cur = reply.value || '';
  const start = reply.selectionStart ?? cur.length;
  const end = reply.selectionEnd ?? start;
  const before = cur.slice(0, start);
  const after = cur.slice(end);
  const lead = before && !before.endsWith('\n') ? '\n' : '';
  const tail = after && !after.startsWith('\n') ? '\n' : '';
  const next = before + lead + ref + tail + after;
  reply.value = next;
  const pos = (before + lead + ref).length;
  try { reply.setSelectionRange(pos, pos); } catch {}
  autoExpandReply();
  persistDraft();
  reply.focus();
}

function installFileTarget(target) {
  if (!target) return;
  target.addEventListener('paste', (e) => {
    if (e.defaultPrevented) return;
    if (!hasFilePayload(e)) return;
    e.preventDefault();
    addFiles(filesFromTransfer(e.clipboardData));
  });
  target.addEventListener('dragover', (e) => {
    if (e.defaultPrevented) return;
    if (!hasFilePayload(e) && !hasReferencePayload(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    messageBox.classList.add('dragover');
  });
  target.addEventListener('dragleave', (e) => {
    if (!messageBox.contains(e.relatedTarget)) messageBox.classList.remove('dragover');
  });
  target.addEventListener('drop', (e) => {
    if (e.defaultPrevented) return;
    if (hasReferencePayload(e)) {
      e.preventDefault();
      messageBox.classList.remove('dragover');
      insertComposerReference(referenceFromTransfer(e.dataTransfer));
      return;
    }
    if (!hasFilePayload(e)) return;
    e.preventDefault();
    messageBox.classList.remove('dragover');
    addFiles(filesFromTransfer(e.dataTransfer));
    reply.focus();
  });
}

window.addEventListener('aios:insert-reference', (e) => insertComposerReference(e.detail?.text || ''));

async function sendInput() {
  const text = reply.value.trim();
  const uploaded = readyAttachments();
  if (!text && !uploaded.length) return;
  if (uploadsPending()) return alert('Wait for attachments to finish uploading first.');
  sendBtn.disabled = true;
  try {
    const r = await fetch(`api/session/${id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, attachments: uploaded, source: uploaded.length ? 'text+attachments' : 'text' }),
    });
    if (r.status === 409) {
      showResumeBar(); // in-theme inline bar — native confirm() is unreadable and off-theme
    } else if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert('Send failed: ' + (j.error || r.status));
    } else {
      pushHistory(text); // record the sent message for ArrowUp recall + clear the saved draft
      reply.value = '';
      clearAttachments();
    }
  } catch (e) {
    alert('Send failed: ' + e.message);
  } finally {
    updateSendState();
    autoExpandReply();
    reply.focus();
  }
}
$('#b-resume').onclick = async () => {
  $('#b-resume').disabled = true;
  try {
    await api(`api/session/${id}/resume`, { method: 'POST' });
    setTimeout(() => location.reload(), 900);
  } catch (e) {
    alert('Resume failed: ' + e.message);
    $('#b-resume').disabled = false;
  }
};
sendBtn.onclick = sendInput;
// ---- "/" command palette (composer) -----------------------------------------
// Type "/" at the start of the message box to open a small menu (like Claude Code / Codex desktop).
// Commands are derived live from the existing session-settings controls (#s-settings) + the action
// buttons, so they always match what this session supports; applying one just drives that existing
// control (no duplicated settings logic). A "/cmd" that isn't a known Supercalm command is offered as
// "send to agent" — covering codex/claude's own line commands (/compact, …). For the agent's NATIVE
// interactive menu, type "/" directly in the terminal.
const palette = document.createElement('div');
palette.className = 'cmd-palette';
palette.hidden = true;
document.body.appendChild(palette); // body + position:fixed so the composer's overflow:auto can't clip it
let paletteItems = [];
let paletteSel = 0;
const paletteOpen = () => !palette.hidden;

function paletteCommands() {
  const cmds = [];
  const LABEL = { autonomy: 'permissions', effort: 'effort', model: 'model', orchestration: 'orchestration' };
  $('#s-settings')?.querySelectorAll('select[data-set]').forEach((sel) => {
    const cur = sel.options[sel.selectedIndex]?.text || '';
    cmds.push({ name: LABEL[sel.dataset.set] || sel.dataset.set, hint: cur, run: () => { sel.focus(); try { sel.showPicker ? sel.showPicker() : sel.click(); } catch { sel.click(); } } });
  });
  const fast = $('#s-settings')?.querySelector('button[data-toggle="fastMode"]');
  if (fast) cmds.push({ name: 'fast', hint: fast.getAttribute('aria-pressed') === 'true' ? 'on' : 'off', run: () => fast.click() });
  cmds.push({ name: 'task', hint: 'new task card', run: () => window.dispatchEvent(new CustomEvent('aios:new-task')) });
  cmds.push({ name: 'stop', hint: 'Ctrl-C', run: () => $('#b-stop').click() });
  cmds.push({ name: 'kill', hint: 'end session', run: () => $('#b-kill').click() });
  const resume = $('#b-resume');
  if (resume && !resume.hidden) cmds.push({ name: 'resume', hint: 'restart', run: () => resume.click() });
  // saved prompt snippets (quick-insert) + the manager
  snippets.forEach((s) => cmds.push({ name: s.name, hint: 'snippet', snippet: s }));
  cmds.push({ name: 'snippets', hint: 'manage saved prompts', run: () => openSnippetManager() });
  return cmds;
}

function renderPalette() {
  palette.innerHTML = paletteItems
    .map((it, i) => `<div class="cmd-item ${i === paletteSel ? 'sel' : ''}" data-i="${i}"><span class="cmd-name">/${escapeHtml(it.name)}</span>${it.hint ? `<span class="cmd-hint">${escapeHtml(it.hint)}</span>` : ''}</div>`)
    .join('');
  palette.querySelectorAll('.cmd-item').forEach((el) => {
    el.onmousedown = (e) => { e.preventDefault(); applyPalette(Number(el.dataset.i)); }; // mousedown keeps reply focused
  });
}

function closePalette() { palette.hidden = true; paletteItems = []; }

function applyPalette(i) {
  const it = paletteItems[i];
  if (!it) return;
  closePalette();
  if (it.send) return sendInput(); // unknown "/cmd" -> send the whole line to the agent
  if (it.snippet) return insertSnippet(it.snippet.body); // saved prompt -> drop into the composer to edit/send
  reply.value = '';
  autoExpandReply();
  persistDraft(); // the "/cmd" was consumed by a setting, not typed text — drop it from the saved draft
  it.run();
}

function syncPalette() {
  const m = /^\/(\S*)$/.exec(reply.value); // leading "/" and no space yet
  if (!m) { if (paletteOpen()) closePalette(); return; }
  const q = m[1].toLowerCase();
  const matches = paletteCommands().filter((c) => c.name.startsWith(q));
  paletteItems = matches.length ? matches : [{ name: reply.value.slice(1) || '…', hint: 'send to agent', send: true }];
  paletteSel = 0;
  renderPalette();
  const r = reply.getBoundingClientRect(); // anchor just above the composer
  palette.style.left = `${Math.round(r.left)}px`;
  palette.style.width = `${Math.round(r.width)}px`;
  palette.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`;
  palette.hidden = false;
}

// ---- composer history + crash-proof draft -----------------------------------
// Terminal-style recall: ArrowUp/Down cycle previously-sent messages for THIS session. The unsent draft is
// stashed the moment you step into history and brought back the instant you arrow down past the newest
// entry — so an accidental arrow can never eat what you typed. The live draft is also mirrored to
// localStorage on every keystroke, so a refresh/crash/tab-close never loses a single word. Recall only
// fires when the "/" palette is closed and the caret sits on the first/last line, so multi-line editing and
// the palette both keep working untouched. (cmdHistory — not `history` — to avoid shadowing window.history.)
const DRAFT_KEY = `aios_draft_${id}`;
const HIST_KEY = `aios_hist_${id}`;
const HIST_MAX = 200;
let cmdHistory = [];
let histIdx = null; // null = editing the live draft; otherwise an index into cmdHistory
let histStash = ''; // the live draft, parked here while you browse history
try { cmdHistory = (JSON.parse(localStorage.getItem(HIST_KEY) || '[]') || []).filter((x) => typeof x === 'string'); } catch {}

function persistDraft() {
  // Save the REAL unsent draft, never a peeked history entry: while navigating that's the stash.
  const v = histIdx === null ? reply.value : histStash;
  try { v ? localStorage.setItem(DRAFT_KEY, v) : localStorage.removeItem(DRAFT_KEY); } catch {}
}
function pushHistory(text) {
  const t = String(text || '').trim();
  if (t && cmdHistory[cmdHistory.length - 1] !== t) { // dedupe consecutive repeats, like a shell
    cmdHistory.push(t);
    if (cmdHistory.length > HIST_MAX) cmdHistory = cmdHistory.slice(-HIST_MAX);
    try { localStorage.setItem(HIST_KEY, JSON.stringify(cmdHistory)); } catch {}
  }
  histIdx = null;
  histStash = '';
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
}
function setComposer(val) {
  reply.value = val ?? '';
  autoExpandReply();
  const n = reply.value.length;
  try { reply.setSelectionRange(n, n); } catch {} // caret to end, like a recalled shell line
}
function caretAtFirstLine() {
  return reply.selectionStart === reply.selectionEnd && !reply.value.slice(0, reply.selectionStart).includes('\n');
}
function caretAtLastLine() {
  return reply.selectionStart === reply.selectionEnd && !reply.value.slice(reply.selectionEnd).includes('\n');
}
function historyPrev() { // ArrowUp -> older
  if (!cmdHistory.length) return;
  if (histIdx === null) { histStash = reply.value; histIdx = cmdHistory.length; } // entering history: park the draft
  histIdx = Math.max(0, histIdx - 1);
  setComposer(cmdHistory[histIdx]);
}
function historyNext() { // ArrowDown -> newer; stepping past the newest restores the parked draft
  if (histIdx === null) return;
  histIdx += 1;
  if (histIdx >= cmdHistory.length) { histIdx = null; setComposer(histStash); }
  else setComposer(cmdHistory[histIdx]);
}
// Bring back a draft from a previous visit/refresh (only when the box is currently empty, so we never
// clobber freshly-typed text). pagehide is a belt-and-suspenders flush for any path that skips 'input'.
try {
  const saved = localStorage.getItem(DRAFT_KEY);
  if (saved && !reply.value) { reply.value = saved; autoExpandReply(); }
} catch {}
addEventListener('pagehide', persistDraft);

// ---- composer parity: Enter-to-send, send-key hint, paste-to-file, saved snippets ----------------
// Match the muscle memory of the Claude / ChatGPT composers so switching to Supercalm feels seamless.
const hintEl = $('#composer-hint');
let enterSends = localStorage.getItem('aios_enter_sends') !== '0'; // default: Enter sends, Shift+Enter = newline
let lastFreeText = reply.value || ''; // most recent NON-slash draft — seeds "save as snippet"
let snippets = [];
const PASTE_FILE_CHARS = 2500; // a paste larger than this (or with many lines) becomes an attachment
const PASTE_FILE_LINES = 40;

function renderSendHint() {
  if (!hintEl) return;
  if (!finePointer.matches) { hintEl.hidden = true; return; } // touch: Return = newline, send with the button
  const cmd = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '') ? '⌘' : 'Ctrl';
  hintEl.hidden = false;
  hintEl.textContent = enterSends ? '⏎ send · ⇧⏎ newline' : `${cmd}⏎ send · ⏎ newline`;
}
if (hintEl)
  hintEl.onclick = () => {
    enterSends = !enterSends;
    try { localStorage.setItem('aios_enter_sends', enterSends ? '1' : '0'); } catch {}
    renderSendHint();
    reply.focus();
  };

// Big paste -> file chip: the agent gets a clean file and the composer stays readable. Clipboard FILES are
// handled by installFileTarget; here we only intercept LARGE plain text (small pastes still go inline).
reply.addEventListener('paste', (e) => {
  if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length) return; // a real file paste
  const text = e.clipboardData ? e.clipboardData.getData('text') : '';
  if (!text) return;
  if (text.length <= PASTE_FILE_CHARS && text.split('\n').length <= PASTE_FILE_LINES) return; // small -> inline
  e.preventDefault();
  addFiles([new File([text], `pasted-${++attachmentSeq}.txt`, { type: 'text/plain' })], { source: 'paste' });
});

// Saved prompt snippets — stored server-side (cross-device), surfaced as "/name" in the command palette.
async function loadSnippets() {
  try { const r = await api('api/snippets'); snippets = Array.isArray(r?.snippets) ? r.snippets : []; } catch {}
}
function insertSnippet(body) {
  histIdx = null;
  setComposer(body || '');
  persistDraft();
  reply.focus();
}
function openSnippetManager() {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.innerHTML = `<div class="box">
      <h3>Saved prompts</h3>
      <label for="sn-name">Name</label>
      <input id="sn-name" maxlength="80" placeholder="tests" autocomplete="off" />
      <label for="sn-body">Prompt</label>
      <textarea id="sn-body" rows="4" placeholder="run the tests and report any failures"></textarea>
      <div class="row"><button class="btn" id="sn-save">Save</button><span class="msg" id="sn-msg"></span><button class="btn ghost" id="sn-close" style="margin-left:auto">Close</button></div>
      <div class="snippet-list" id="sn-list"></div>
    </div>`;
  document.body.appendChild(overlay);
  const q = (s) => overlay.querySelector(s);
  q('#sn-body').value = lastFreeText || ''; // seed with what you just typed, so "save this prompt" is one step
  const close = () => overlay.remove();
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  q('#sn-close').onclick = close;
  const renderList = () => {
    q('#sn-list').innerHTML = snippets.length
      ? snippets
          .map(
            (s) =>
              `<div class="snippet-item"><div class="snippet-meta"><b>/${escapeHtml(s.name)}</b><span>${escapeHtml((s.body || '').replace(/\s+/g, ' ').slice(0, 90))}</span></div><button class="btn sm" data-ins="${escapeHtml(s.id)}">Insert</button><button class="btn ghost sm" data-del="${escapeHtml(s.id)}" title="Delete">✕</button></div>`,
          )
          .join('')
      : '<div class="msg">No saved prompts yet — add one above.</div>';
    q('#sn-list').querySelectorAll('[data-ins]').forEach((b) => (b.onclick = () => { const s = snippets.find((x) => x.id === b.dataset.ins); if (s) { insertSnippet(s.body); close(); } }));
    q('#sn-list').querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      try { await api(`api/snippets/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' }); await loadSnippets(); renderList(); }
      catch (err) { q('#sn-msg').textContent = 'Delete failed: ' + err.message; q('#sn-msg').className = 'msg err'; }
    }));
  };
  q('#sn-save').onclick = async () => {
    const name = q('#sn-name').value.trim();
    const body = q('#sn-body').value;
    const msg = q('#sn-msg');
    if (!name || !body.trim()) { msg.textContent = 'Name and prompt are required.'; msg.className = 'msg err'; return; }
    try {
      await api('api/snippets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, body }) });
      q('#sn-name').value = '';
      await loadSnippets();
      renderList();
      msg.textContent = 'Saved.'; msg.className = 'msg';
    } catch (err) { msg.textContent = 'Save failed: ' + err.message; msg.className = 'msg err'; }
  };
  renderList();
  setTimeout(() => q('#sn-name').focus(), 30);
}

// Operator-presence heartbeat: while you're actively composing a reply, tell the server so the autonomous
// supervisor holds its auto-sends instead of interleaving with your half-typed message. It resumes a few
// seconds after you stop / send / blur. Throttled to spare the network; a timer also beats during a thinking
// pause (focused + non-empty) so the supervisor stays held while you pause mid-draft.
let lastTypingPing = 0;
function pingTyping() {
  const t = Date.now();
  if (t - lastTypingPing < 1500) return; // throttle: at most one ping per 1.5s while typing fast
  lastTypingPing = t;
  fetch(`api/session/${id}/typing`, { method: 'POST' }).catch(() => {});
}
setInterval(() => { if (reply.value.trim() && document.activeElement === reply) pingTyping(); }, 3000);

reply.addEventListener('input', () => {
  histIdx = null;
  autoExpandReply();
  syncPalette();
  persistDraft();
  if (reply.value.trim()) pingTyping(); // you're composing -> ask the supervisor to stand down
  if (!reply.value.startsWith('/')) lastFreeText = reply.value; // remember real prose, not a "/command"
});
reply.addEventListener('keydown', (e) => {
  if (paletteOpen()) {
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteSel = Math.min(paletteSel + 1, paletteItems.length - 1); renderPalette(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); paletteSel = Math.max(paletteSel - 1, 0); renderPalette(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyPalette(paletteSel); return; }
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
  }
  // terminal-style history recall — only when the palette is closed, no modifier is held, and the caret is
  // at the edge line (so Up/Down still move within a multi-line draft; only the boundary recalls history).
  if (!paletteOpen() && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.isComposing) {
    if (e.key === 'ArrowUp' && cmdHistory.length && caretAtFirstLine()) { e.preventDefault(); historyPrev(); return; }
    if (e.key === 'ArrowDown' && histIdx !== null && caretAtLastLine()) { e.preventDefault(); historyNext(); return; }
  }
  // Enter-to-send (matches Claude/ChatGPT): on desktop Enter sends and Shift+Enter makes a newline; the
  // toggle (the send-key hint) flips to Cmd/Ctrl+Enter for people who'd rather Enter stay a newline.
  // Cmd/Ctrl+Enter ALWAYS sends in either mode. On touch we never send on Enter — Return = newline, use ↑.
  if (e.key === 'Enter' && !e.isComposing && !paletteOpen()) {
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); sendInput(); return; }
    if (enterSends && finePointer.matches && !e.shiftKey && !e.altKey) { e.preventDefault(); sendInput(); return; }
  }
});
reply.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== reply) closePalette(); }, 120));
attachBtns.forEach((btn) => {
  btn.onclick = () => fileInput.click();
});
fileInput.onchange = () => {
  addFiles(fileInput.files);
  fileInput.value = '';
};
installFileTarget(messageBox);
installFileTarget(document.querySelector('.session-main'));
addEventListener('resize', autoExpandReply);
compactComposerQuery.addEventListener?.('change', syncReplyPlaceholder);
wireMic(micBtn, reply, $('#mic-status'));
syncReplyPlaceholder();

// Input routing. On desktop the terminal is interactive: clicking it focuses the terminal textarea and
// our keydown handler forwards keystrokes to the live pane. On touch we keep it display-only (focusing
// it would pop the keyboard for laggy per-keystroke typing), so taps go to the composer. We track which
// input you last used, so if the terminal silently loses focus (e.g. a background re-render) your next
// keystroke goes BACK to the terminal instead of leaking into the composer — the main focus-reliability
// fix for "the slash command sometimes doesn't work."
const finePointer = matchMedia('(pointer: fine)');
renderSendHint(); // now that finePointer exists: show the send-key hint (desktop) and reflect the toggle
finePointer.addEventListener?.('change', renderSendHint);
loadSnippets(); // populate the "/" palette's saved prompts
let lastInputTerminal = false;
reply.addEventListener('focus', () => { lastInputTerminal = false; });
if (finePointer.matches) {
  // desktop: clicking the terminal focuses its (read-only) textarea directly — focusing the element
  // fires its 'focus' event so xterm shows the cursor, and our textarea keydown handler then captures
  // typing. (Use the element's own .focus(), not term.focus(), which can no-op with disableStdin.)
  termEl.addEventListener('mousedown', (e) => {
    if (e.target.closest('.jump-latest')) return;
    lastInputTerminal = true;
    setTimeout(() => { try { termTextarea?.focus({ preventScroll: true }); } catch {} }, 0);
  });
} else {
  // touch: keep the terminal display-only (a read-only textarea won't pop the soft keyboard anyway);
  // send taps to the composer.
  termEl.addEventListener('pointerup', () => {
    try { termTextarea?.blur(); } catch {}
    if (document.activeElement !== reply) reply.focus();
  });
}
// A printable key pressed while nothing is focused goes to wherever you were last typing: back into the
// live terminal (re-focus + forward) if that was the terminal, otherwise it starts a composer message.
addEventListener('keydown', (e) => {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.length !== 1) return; // printable single chars only
  if (e.target !== document.body) return; // only when truly nothing is focused (not the terminal/inputs)
  e.preventDefault();
  if (lastInputTerminal && finePointer.matches && termTextarea) {
    try { termTextarea.focus({ preventScroll: true }); } catch {}
    sendToPane(e.key); // restore the terminal you were using and forward the key to the live pane
    return;
  }
  reply.focus();
  const start = reply.selectionStart ?? reply.value.length;
  const end = reply.selectionEnd ?? reply.value.length;
  reply.value = reply.value.slice(0, start) + e.key + reply.value.slice(end);
  reply.setSelectionRange(start + 1, start + 1);
  reply.dispatchEvent(new Event('input', { bubbles: true }));
});

// ---- control keys -----------------------------------------------------------
const KEYS = [['Enter', 'enter'], ['Esc', 'esc'], ['↑', 'up'], ['↓', 'down'], ['Tab', 'tab'], ['1', '1'], ['2', '2'], ['3', '3'], ['y', 'y'], ['n', 'n'], ['^C', 'ctrl-c']];
const keysBox = $('#keys');
for (const [label, key] of KEYS) {
  const b = document.createElement('button');
  b.className = 'btn ghost sm';
  b.textContent = label;
  b.onclick = () =>
    api(`api/session/${id}/key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) }).catch(() => {});
  keysBox.appendChild(b);
}

// ---- actions ----------------------------------------------------------------
// Flash transient feedback on a header action button. The old handlers swallowed every result
// (`.catch(()=>{})`) and changed nothing on screen, so a SUCCESSFUL stop looked identical to a failure —
// "I confirmed and nothing happened". Now success/failure is visible, and a hung POST on a flaky tailnet
// link can't leave the button silently stuck (AbortController timeout + finally re-enable).
function flashBtn(btn, text, ok = true) {
  if (!btn) return;
  if (btn._origText == null) btn._origText = btn.textContent;
  btn.textContent = text;
  btn.style.color = ok ? '#3fb950' : '#f85149';
  btn.style.borderColor = (ok ? '#3fb950' : '#f85149') + '99';
  clearTimeout(btn._flash);
  btn._flash = setTimeout(() => {
    btn.textContent = btn._origText;
    btn.style.color = '';
    btn.style.borderColor = '';
  }, ok ? 1600 : 3200);
}
async function postAction(path, { signalMs = 8000 } = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), signalMs);
  try {
    return await api(path, { method: 'POST', signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}
$('#b-stop').onclick = async () => {
  // Stop PARKS the session (frees the pane) but keeps it resumable — not a bare Ctrl-C, which did nothing
  // on an already-idle agent. Resume relaunches with the conversation intact.
  if (!confirm('Stop this session? It frees the pane but stays resumable — Resume brings the conversation back.')) return;
  const btn = $('#b-stop');
  btn.disabled = true;
  try {
    await postAction(`api/session/${id}/stop`);
    flashBtn(btn, 'Stopped ✓', true);
    $('#b-resume').hidden = false; // session is exited now -> offer Resume right away
  } catch {
    flashBtn(btn, 'Failed', false);
  } finally {
    btn.disabled = false;
  }
};
$('#b-kill').onclick = async () => {
  if (!confirm('Kill this tmux session? The agent process ends.')) return;
  const btn = $('#b-kill');
  btn.disabled = true;
  try {
    await postAction(`api/session/${id}/kill`);
    location.href = document.baseURI; // navigating away is the success signal
  } catch {
    flashBtn(btn, 'Failed', false); // don't redirect on failure — that would hide a still-alive session
    btn.disabled = false;
  }
};
