export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export async function api(path, opts) {
  const r = await fetch(path, opts);
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('json') ? await r.json().catch(() => ({})) : await r.text();
  if (!r.ok) throw new Error((body && body.error) || r.status);
  return body;
}

// Coalesce a hot event stream into at most one call per `ms` (leading edge fires
// immediately, trailing edge catches the last burst). The 'changed' SSE fires on every
// poll tick of every working agent — refetching state per event floods slow/relayed links.
export function coalesce(fn, ms = 2500) {
  let timer = null, queued = false;
  const run = () => {
    fn();
    timer = setTimeout(() => {
      timer = null;
      if (queued) { queued = false; run(); }
    }, ms);
  };
  return () => { if (timer) queued = true; else run(); };
}

// The recurring "it resets itself" bug: components re-render via innerHTML on the SSE-'changed' timer
// (~every 3s), which destroys any DOM-only state. This returns true when the user is actively
// interacting with `el` — a focused input/textarea/select, an OPEN <details>, or a live text selection
// inside it — so a refresh handler can SKIP re-rendering that subtree until the user is done with it.
// Use at every timer-driven re-render entry point; the tabs/dots/etc. outside `el` still update.
export function isInteracting(el) {
  if (!el || !el.contains) return false;
  const a = document.activeElement;
  if (a && a !== document.body && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName || '') && el.contains(a)) return true;
  if (a && a.isContentEditable && el.contains(a)) return true;
  if (el.querySelector('details[open]')) return true;
  const sel = typeof getSelection === 'function' ? getSelection() : null;
  if (sel && !sel.isCollapsed && sel.anchorNode && el.contains(sel.anchorNode)) return true;
  return false;
}

export function fmtAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const STATUS_META = {
  waiting: { color: '#d29922', glyph: '!', prefix: '! ', label: 'waiting' },
  working: { color: '#3fb950', glyph: '', prefix: '> ', label: 'working' },
  starting: { color: '#58a6ff', glyph: '', prefix: '> ', label: 'starting' },
  exited: { color: '#8b949e', glyph: 'x', prefix: 'x ', label: 'exited' },
  error: { color: '#f85149', glyph: '!', prefix: '! ', label: 'error' },
  ready: { color: '#58a6ff', glyph: '', prefix: '', label: 'ready' },
};

function compactTabText(s, max = 64) {
  const text = String(s || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, Math.max(0, max - 3)).trimEnd() + '...' : text;
}

function safeHexColor(value, fallback = '#58a6ff') {
  const s = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : fallback;
}

function faviconLink() {
  let link = document.querySelector('link[rel~="icon"][data-aios-dynamic]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.setAttribute('data-aios-dynamic', '1');
    document.head.appendChild(link);
  }
  return link;
}

export function setAiosFavicon({ label = 'A', status = 'ready', accent = '#58a6ff' } = {}) {
  const meta = STATUS_META[status] || STATUS_META.ready;
  const letters = String(label || 'A').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'A';
  const accentColor = safeHexColor(accent);
  const fontSize = letters.length > 1 ? 24 : 34;
  const badgeText = meta.glyph
    ? `<text x="49" y="21" font-family="ui-monospace,Menlo,monospace" font-size="14" font-weight="800" text-anchor="middle" fill="#0d1117">${meta.glyph}</text>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="14" fill="#0d1117"/>
    <rect x="3.5" y="3.5" width="57" height="57" rx="11" fill="none" stroke="${meta.color}" stroke-width="3"/>
    <text x="32" y="43" font-family="ui-monospace,Menlo,monospace" font-size="${fontSize}" font-weight="800" text-anchor="middle" fill="${accentColor}">${letters}</text>
    <circle cx="49" cy="16" r="9" fill="${meta.color}"/>${badgeText}
  </svg>`;
  faviconLink().href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  const theme = document.querySelector('meta[name="theme-color"]');
  if (theme) theme.content = '#0d1117';
}

export function setSessionBrowserIdentity(session) {
  const s = session || {};
  const meta = STATUS_META[s.status] || STATUS_META.ready;
  const title = compactTabText(s.title || 'Session', 58);
  const project = compactTabText(s.project?.name || s.toolLabel || s.tool || 'Supercalm', 24);
  document.title = `${meta.prefix}${title} · ${project} · ${meta.label}`;
  const tool = String(s.tool || s.toolLabel || '');
  const letter = tool === 'codex' ? 'X' : tool === 'claude' ? 'C' : tool === 'agy' ? 'A' : (s.project?.name || 'A').slice(0, 1);
  setAiosFavicon({ label: letter, status: s.status, accent: s.toolColor || '#58a6ff' });
}

export function setDashboardBrowserIdentity(state = {}) {
  const c = state.counts || {};
  const waiting = Number(c.waiting || 0);
  const working = Number(c.working || 0);
  const live = Number(c.live || 0);
  const status = waiting ? 'waiting' : working ? 'working' : live ? 'ready' : 'exited';
  document.title = waiting ? `! ${waiting} waiting · Supercalm` : live ? `${working} working · ${live} live · Supercalm` : 'Supercalm · idle';
  setAiosFavicon({ label: 'A', status });
}

// Flat (currentColor) SVG icons for the mic button.
export const ICON = {
  mic: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v4"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="15" height="15"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/></svg>',
  spin: '<svg class="spin" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round"/></svg>',
};

const STT_LAST_LANG_KEY = 'aios_stt_last_lang';

export function normalizeSpeechLanguage(lang) {
  const value = String(lang || '').trim().replace('_', '-');
  if (!value) return '';
  const lower = value.toLowerCase();
  if (lower === 'auto') return '';
  if (lower.startsWith('zh') || lower.includes('chinese') || lower === 'cmn' || lower === 'yue') return lower.includes('tw') || lower.includes('hk') || lower === 'yue' ? 'zh-TW' : 'zh-CN';
  if (lower.startsWith('en')) return 'en-US';
  if (lower.startsWith('ja')) return 'ja-JP';
  if (lower.startsWith('ko')) return 'ko-KR';
  if (lower.startsWith('fr')) return 'fr-FR';
  if (lower.startsWith('de')) return 'de-DE';
  if (lower.startsWith('es')) return 'es-ES';
  if (lower.startsWith('it')) return 'it-IT';
  if (lower.startsWith('pt')) return 'pt-BR';
  if (lower.startsWith('ru')) return 'ru-RU';
  return value;
}

export function rememberSpeechLanguage(lang) {
  const normalized = normalizeSpeechLanguage(lang);
  if (!normalized) return;
  try { localStorage.setItem(STT_LAST_LANG_KEY, normalized); } catch {}
}

function preferredSpeechRecognitionLanguage() {
  try {
    const last = normalizeSpeechLanguage(localStorage.getItem(STT_LAST_LANG_KEY));
    if (last) return last;
  } catch {}
  return 'en-US';
}

function microphoneConstraints() {
  const supported = navigator.mediaDevices?.getSupportedConstraints?.() || {};
  const audio = {};
  if (supported.echoCancellation) audio.echoCancellation = true;
  if (supported.noiseSuppression) audio.noiseSuppression = true;
  if (supported.autoGainControl) audio.autoGainControl = true;
  if (supported.channelCount) audio.channelCount = { ideal: 1 };
  return Object.keys(audio).length ? { audio } : { audio: true };
}

function recorderOptions() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return {};
  for (const mimeType of ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType };
  }
  return {};
}

async function requestTranscription(blob) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch('api/transcribe?language=auto&polish=false', { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob, signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.status);
    rememberSpeechLanguage(j.language);
    return (j.text || '').trim();
  } finally {
    clearTimeout(timeout);
  }
}

export function createLiveSpeechRecognizer({ onUpdate, onStatus } = {}) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return { supported: false, start() {}, stop() {}, abort() {}, getText: () => '' };
  let rec = null,
    text = '',
    active = false;
  const emit = (next) => {
    text = String(next || '').replace(/\s+/g, ' ').trim();
    onUpdate?.(text);
  };
  return {
    supported: true,
    start() {
      try {
        rec = new SpeechRecognition();
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        rec.lang = preferredSpeechRecognitionLanguage();
        rec.onstart = () => {
          active = true;
          onStatus?.('live');
        };
        rec.onresult = (event) => {
          let finalText = '';
          let interimText = '';
          for (let i = 0; i < event.results.length; i += 1) {
            const piece = event.results[i][0]?.transcript || '';
            if (event.results[i].isFinal) finalText += ' ' + piece;
            else interimText += ' ' + piece;
          }
          emit(`${finalText} ${interimText}`);
        };
        rec.onerror = () => onStatus?.('offline');
        rec.onend = () => {
          active = false;
          onStatus?.('stopped');
        };
        rec.start();
      } catch {
        active = false;
        onStatus?.('offline');
      }
    },
    stop() {
      try {
        if (active && rec) rec.stop();
      } catch {}
      active = false;
    },
    abort() {
      try {
        if (rec) rec.abort();
      } catch {}
      active = false;
    },
    getText() {
      return text;
    },
  };
}

function setTextWithLivePreview(target, baseText, liveText) {
  const next = [baseText, liveText].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
  target.value = next;
  target.dispatchEvent(new Event('input', { bubbles: true }));
}

// Tap-to-toggle dictation via Spark: tap to record, tap to stop -> transcribe.
// One unified `click` handler avoids the mouse/touch double-firing that produced
// empty clips. `statusEl` (optional) shows recording / transcribing stages.
export function wireMic(btn, target, statusEl, { hold = false } = {}) {
  // hold-to-talk (spec) applies on TOUCH only — press-hold-record, release-to-transcribe; desktop keeps
  // tap-to-toggle. Default (no opt) is tap-to-toggle everywhere, so existing callers are unchanged.
  const holdMode = hold && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  let rec = null,
    chunks = [],
    stream = null,
    startedAt = 0,
    live = null,
    baseText = '';
  const setState = (s) => {
    btn.classList.toggle('rec', s === 'recording');
    btn.disabled = s === 'busy';
    btn.innerHTML = s === 'recording' ? ICON.stop : s === 'busy' ? ICON.spin : ICON.mic;
    btn.title = s === 'recording' ? 'Stop & transcribe' : 'Dictate (Spark)';
    if (statusEl) statusEl.textContent = s === 'recording' ? '● listening…' : s === 'busy' ? 'finalizing…' : '';
  };
  setState('idle');
  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints());
    } catch (e) {
      alert('Microphone permission is needed to dictate.\n' + e.message);
      return;
    }
    chunks = [];
    baseText = target.value.trim();
    live = createLiveSpeechRecognizer({
      onUpdate: (text) => setTextWithLivePreview(target, baseText, text),
      onStatus: (status) => {
        if (!statusEl || rec?.state === 'inactive') return;
        if (status === 'live') statusEl.textContent = '● live preview…';
        if (status === 'offline') statusEl.textContent = '● listening…';
      },
    });
    const opts = recorderOptions();
    rec = new MediaRecorder(stream, opts);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      live?.stop();
      stream.getTracks().forEach((t) => t.stop());
      const elapsed = Date.now() - startedAt;
      const blob = new Blob(chunks, { type: rec.mimeType || opts.mimeType || chunks[0]?.type || 'audio/webm' });
      if (blob.size < 1200 || elapsed < 400) {
        setState('idle');
        if (!holdMode) alert('No audio captured — tap the mic, speak, then tap stop.'); // a too-short hold cancels silently
        return;
      }
      setState('busy');
      try {
        const liveText = live?.getText() || '';
        let text = liveText;
        try {
          text = (await requestTranscription(blob)) || liveText;
        } catch (e) {
          if (!liveText) throw e;
        }
        if (!text) {
          alert('No speech detected — try again.');
          return;
        }
        target.value = [baseText, text].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.focus();
      } catch (e) {
        alert('Transcription failed: ' + e.message);
      } finally {
        live?.abort();
        live = null;
        setState('idle');
      }
    };
    rec.start(250);
    startedAt = Date.now();
    setState('recording');
    live.start();
  }
  function stop() {
    live?.stop();
    if (rec && rec.state !== 'inactive') rec.stop();
  }
  if (holdMode) {
    // Press-and-hold to record; release (or slide off / cancel) to transcribe. Pointer capture keeps the
    // release even if the finger drifts off the 40px target mid-utterance.
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); if (rec && rec.state === 'recording') return; try { btn.setPointerCapture(e.pointerId); } catch {} start(); });
    const end = () => { if (rec && rec.state === 'recording') stop(); };
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointercancel', end);
  } else {
    btn.addEventListener('click', (e) => { e.preventDefault(); rec && rec.state === 'recording' ? stop() : start(); });
  }
  // Handle for hosts that can disappear mid-recording (e.g. the launch modal): abort() discards the
  // take without transcribing and releases the mic, so closing the host never leaves the mic live.
  return {
    stop,
    abort() {
      try { if (rec) { rec.ondataavailable = null; rec.onstop = null; if (rec.state !== 'inactive') rec.stop(); } } catch {}
      try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
      live?.abort();
      live = null;
      setState('idle');
    },
  };
}

// ---- push notifications (PWA) ----------------------------------------------
export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('sw.js');
  } catch {
    return null;
  }
}

function urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('Push not supported here. On iPhone/iPad, add Supercalm to your Home Screen first.');
    return false;
  }
  const reg = await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    alert('Notifications were not granted.');
    return false;
  }
  const { key } = await api('api/vapidPublicKey');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
  await api('api/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub) });
  return true;
}

export async function pushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  return sub ? 'on' : 'off';
}

// --- minimal, XSS-safe markdown renderer (shared: file viewer, docs) ------------------------------
// Untrusted input: every text span is escaped FIRST; only renderer-generated tags exist in the output.
// Supports: h1–h6, fenced code, GFM tables, ul/ol (+ checkboxes), blockquote, hr, bold/italic/inline
// code, links (http/https/mailto/#/relative only — javascript: etc. render as plain text). Images
// render as links on purpose: an <img> to an attacker URL would leak the viewer's address.
const MD_ESC = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function mdSafeHref(h) {
  const t = String(h || '').trim();
  if (/^(https?:|mailto:|#)/i.test(t)) return t;
  if (/^[\w./-][\w./?#=&%-]*$/.test(t) && !t.includes(':')) return t; // relative path
  return null;
}
function mdInline(s) {
  let x = MD_ESC(s);
  x = x.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // links + images (image -> link). Href was escaped by MD_ESC; sanitize scheme on the raw-ish value.
  x = x.replace(/!?\[([^\]]*)\]\(([^()\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label, href) => {
    const safe = mdSafeHref(href.replace(/&amp;/g, '&'));
    if (!safe) return m;
    return `<a href="${MD_ESC(safe)}" target="_blank" rel="noopener noreferrer">${label || MD_ESC(safe)}</a>`;
  });
  x = x.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  x = x.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  x = x.replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  return x;
}
export function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  let list = null; // {tag, items} open list tag
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      out.push(`<pre><code>${MD_ESC(buf.join('\n'))}</code></pre>`);
      continue;
    }
    // GFM table: header row + separator row
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[|\s:-]*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      closeList();
      const rowCells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = rowCells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(rowCells(lines[i++]));
      out.push('<table><thead><tr>' + head.map((c) => `<th>${mdInline(c)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + head.map((_, k) => `<td>${mdInline(r[k] ?? '')}</td>`).join('') + '</tr>').join('')
        + '</tbody></table>');
      continue;
    }
    const t = line.trim();
    if (!t) { closeList(); i++; continue; }
    if (/^(---|\*\*\*|___)\s*$/.test(t)) { closeList(); out.push('<hr>'); i++; continue; }
    const h = t.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (h) { closeList(); const n = h[1].length; out.push(`<h${n}>${mdInline(h[2])}</h${n}>`); i++; continue; }
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      closeList();
      const buf = [q[1]];
      i++;
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ol || ul) {
      const tag = ol ? 'ol' : 'ul';
      if (list !== tag) { closeList(); out.push(`<${tag}>`); list = tag; }
      let item = (ol || ul)[1];
      const box = item.match(/^\[([ xX])\]\s+(.*)$/);
      if (box) item = `<input type="checkbox" disabled${box[1] !== ' ' ? ' checked' : ''}> ${mdInline(box[2])}`;
      else item = mdInline(item);
      out.push(`<li>${item}</li>`);
      i++;
      continue;
    }
    // paragraph: gather consecutive plain lines
    closeList();
    const buf = [t];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+[.)]\s|\s*>|\s*\|)/.test(lines[i]) && !/^(---|\*\*\*)\s*$/.test(lines[i].trim())) buf.push(lines[i++].trim());
    out.push(`<p>${mdInline(buf.join(' '))}</p>`);
  }
  closeList();
  return out.join('\n');
}
