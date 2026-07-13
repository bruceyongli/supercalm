// SPA settings view. Mounts into #view; sticky sub-nav + 1:1 homes for every onboarding step, real
// endpoints. Faithful port of the standalone settings.js — the module-top sub-nav `links` binding + the
// initial load*() calls are moved into init() so DOM lookups resolve against the freshly-rendered markup.
// The page depends on onboarding.css (.ob-* classes) which the app shell does NOT load, so init() injects
// that stylesheet + the inline <style> once (guarded by id). The window 'scroll' listener that drives the
// sub-nav active state is captured and removeEventListener'd in teardown() so it leaks nothing on leave.
// View contract: export init(host, params) + teardown().
import { api, escapeHtml as esc } from '../common.js';

const SETTINGS_CSS = `
    /* Design: sub-nav is a VERTICAL column on the left, content on the right (2-col grid). */
    .st-wrap { max-width: 1080px; margin: 0 auto; padding: 32px; display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 30px; align-items: start; }
    .st-head { grid-column: 1 / -1; }
    .st-head h1 { font-family: 'IBM Plex Sans', sans-serif; font-size: 26px; font-weight: 600; letter-spacing: -0.01em; color: #e9eef5; margin: 0 0 6px; }
    .st-nav { position: sticky; top: 16px; display: flex; flex-direction: column; gap: 3px; padding: 0; margin: 0; align-items: stretch; }
    .st-nav a { color: #8a95a5; text-decoration: none; font-size: 13px; font-weight: 500; padding: 8px 12px; border-radius: 9px; }
    .st-nav a:hover { background: #10151d; }
    .st-nav a.active { background: #121a26; box-shadow: inset 2px 0 0 #58a6ff; color: #e9eef5; }
    .st-body { min-width: 0; }
    /* Phone: stack the sub-nav over the content (full-width, readable) + clear the shell's ☰ menu button. */
    @media (max-width: 720px) {
      .st-wrap { grid-template-columns: 1fr; padding: 52px 14px 90px; gap: 14px; }
      .st-nav { position: static; flex-direction: row; flex-wrap: wrap; gap: 6px; }
      .st-nav a { border: 1px solid #232c38; border-radius: 999px; padding: 6px 11px; }
      .st-nav a.active { box-shadow: none; border-color: #58a6ff; }
    }
    .st-sec { margin-bottom: 34px; scroll-margin-top: 64px; }
    .st-sec h2 { font-family: 'IBM Plex Sans', sans-serif; font-size: 17px; font-weight: 600; color: #e9eef5; margin: 0 0 10px; }
    .st-pref { display: flex; align-items: center; gap: 14px; padding: 10px 0; border-bottom: 1px solid #10151d; }
    .st-pref b { font-weight: 600; color: #dde5ee; font-size: 13.5px; }
    .st-pref .sub { color: #5c6675; font-size: 12px; }
    .st-toggle { margin-left: auto; width: 40px; height: 22px; border-radius: 999px; background: #232c38; border: none; position: relative; cursor: pointer; transition: background 0.15s; }
    .st-toggle.on { background: #238636; }
    .st-toggle::after { content: ''; position: absolute; top: 1px; left: 1px; width: 20px; height: 20px; border-radius: 99px; background: #e9eef5; transition: left 0.15s; }
    .st-toggle.on::after { left: 19px; }
    .st-step { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #dde5ee; }
    .st-step button { width: 26px; height: 26px; border-radius: 8px; background: #0b0f16; border: 1px solid #232c38; color: #b9c4d4; cursor: pointer; }
`;

let host = null;
let onScroll = null;
const $ = (s) => document.querySelector(s);

// ---- Agents & sign-in --------------------------------------------------------------------------
async function loadAgents() {
  try {
    const st = await api('api/auth/status');
    if (!host) return; // torn down mid-fetch → $() would resolve to null
    $('#st-authpath').innerHTML = `
      <div class="ob-row"><b>Session auth path</b><span class="dk-chip" style="color:#79b8ff;border-color:#79b8ff55">${esc((st.mode || '?').toUpperCase())}</span>
      <span class="ob-ver">${st.proxyUp ? '● proxy reachable' : 'no local proxy'}</span>
      <button class="dk-reply-btn" id="st-recheck">Re-check proxy</button></div>
      <p class="ob-fine">Sessions auto-detect their auth: an external proxy if present, else Supercalm's own login via a local shim, else the CLI's own login.</p>`;
    $('#st-recheck').onclick = loadAgents;
    // r4 4b: ONE merged card per CLI — install/version state + login state together, never two rows.
    let tools = [];
    try { tools = (await api('api/tools/versions')).tools || []; } catch {}
    if (!host) return; // second suspension point — re-check before touching #st-clis
    const authAlias = { agy: 'antigravity' };
    const authById = {};
    for (const p of st.providers || []) authById[p.id] = p;
    $('#st-clis').innerHTML = tools.map((t) => {
      const a = authById[authAlias[t.id] || t.id] || {};
      const login = a.loggedIn
        ? '<span class="dk-chip" style="color:#4ecb6c;border-color:#4ecb6c55">LOGGED IN</span>'
        : '<span class="dk-chip" style="color:#8a95a5;border-color:currentColor">SIGNED OUT</span>';
      const versionOrInstall = t.installed
        ? `<span class="ob-ver">${esc(t.version || '')}</span>${t.latest && t.latest !== t.version ? `<span class="dk-chip" style="color:#e2b23e;border-color:#e2b23e55">${esc(t.latest)} AVAILABLE</span><button class="dk-reply-btn" data-up="${esc(t.id)}">Update</button>` : ''}`
        : '<span class="ob-ver">not found</span><a class="dk-new sm" href="auth">Install</a>';
      const expiry = a.expiresInSec ? `<span class="ob-ver">token ${Math.round(a.expiresInSec / 3600)}h</span>` : '';
      return `
      <div class="ob-row"><b>${esc(t.id)}</b>
        ${versionOrInstall}
        ${login}
        ${expiry}
        <a class="dk-reply-btn" href="auth">${a.loggedIn ? 'Re-login ▸' : 'Sign in ▸'}</a>
        <span class="ob-msg" data-upmsg="${esc(t.id)}"></span>
      </div>`;
    }).join('');
    for (const b of document.querySelectorAll('[data-up]')) b.onclick = async () => {
      const m = document.querySelector(`[data-upmsg="${b.dataset.up}"]`);
      m.textContent = 'updating…';
      try { await api(`api/tools/${b.dataset.up}/update`, { method: 'POST' }); m.textContent = '✓'; loadAgents(); } catch (e) { m.textContent = '⚠ ' + (e.message || e); }
    };
  } catch (e) { if (host) $('#st-authpath').textContent = 'unavailable: ' + (e.message || e); }
}

// ---- API providers -------------------------------------------------------------------------------
async function loadProviders() {
  try {
    const r = await api('api/models/providers');
    if (!host) return; // torn down mid-fetch
    const builtin = (r.builtin || []).map((p) => `<div class="ob-row"><b>${esc(p.name)}</b><span class="ob-ver">built-in · ${(p.models || []).length} models · key auto</span><span class="dk-chip" style="color:${p.enabled ? '#4ecb6c' : '#8a95a5'};border-color:currentColor">${p.enabled ? 'ON' : 'OFF'}</span></div>`).join('');
    const rows = (r.providers || []).map((p) => `<div class="ob-row"><b>${esc(p.name)}</b><span class="ob-ver">${esc(p.kind)} · ${(p.models || []).length} models · ${p.key_set ? 'key set' : 'no key'}</span></div>`).join('');
    const pr = r.pricing || {};
    $('#st-prov').innerHTML = `${builtin}${rows || (builtin ? '' : '<p class="ob-fine">No API providers yet.</p>')}
      <div class="ob-row"><b>Cost stats</b><span class="ob-ver">${pr.configured ? `✓ ${pr.count} priced models` : 'not configured (optional)'}</span><a class="dk-reply-btn" href="auth">Manage ▸</a></div>`;
  } catch (e) { if (host) $('#st-prov').textContent = 'unavailable: ' + (e.message || e); }
}

// ---- Voice ---------------------------------------------------------------------------------------
async function loadVoice() {
  try {
    const r = await api('api/models/providers');
    if (!host) return; // torn down mid-fetch
    const sp = r.speech;
    $('#st-voicecard').innerHTML = sp?.base_url
      ? `<div class="ob-row"><b>${esc(sp.base_url)}</b><span class="ob-ver">STT ${esc(sp.stt_model || '—')} · TTS ${esc(sp.tts_model || '—')} · voice ${esc(sp.voice || '—')}</span><a class="dk-reply-btn" href="auth">Edit ▸</a></div>`
      : `<p class="ob-fine">Not configured — voice falls back to the browser's built-in speech. <a class="dk-reply-btn" href="auth">Configure ▸</a> or run onboarding step 3.</p>`;
  } catch (e) { if (host) $('#st-voicecard').textContent = 'unavailable'; }
}

// ---- Remote access -------------------------------------------------------------------------------
async function loadRemote() {
  const tailnet = /ts\.net$/.test(location.hostname);
  $('#st-remotecard').innerHTML = `
    <div class="ob-row"><b>${tailnet ? 'Serving over Tailscale' : 'Local access'}</b><i class="dk-dot ${tailnet ? 'ok' : ''}"></i><span class="ob-ver">${esc(location.origin)}</span></div>
    <p class="ob-fine">${tailnet ? 'Open this URL on any tailnet device; on the phone, Add to Home Screen installs the app.' : 'Run bin/expose on the host to serve HTTPS on your tailnet (path /aios); the phone app installs from that URL.'}</p>`;
}

// ---- Preferences (real controls; consumed by the phone/voice surfaces via localStorage) -----------
const PREFS = [
  { key: 'aios_autoplay', label: 'Auto-play unread on open', sub: 'phone: play the unread queue when the app opens', type: 'toggle' },
  { key: 'aios_voice_rate', label: 'Voice rate', sub: 'read-out speed for TTS surfaces', type: 'step', min: 0.5, max: 2, step: 0.1, dflt: 1 },
  { key: 'aios_quickkeys', label: 'Quick-key chips', sub: 'terminal view: Enter/Esc/arrows/y/n row', type: 'toggle', dflt: true },
];
function renderPrefs() {
  $('#st-prefscard').innerHTML = PREFS.map((p) => {
    if (p.type === 'toggle') {
      const on = localStorage.getItem(p.key) == null ? !!p.dflt : localStorage.getItem(p.key) === '1';
      return `<div class="st-pref"><div><b>${esc(p.label)}</b><div class="sub">${esc(p.sub)}</div></div><button class="st-toggle${on ? ' on' : ''}" data-pref="${p.key}" role="switch" aria-checked="${on}"></button></div>`;
    }
    const v = Number(localStorage.getItem(p.key) || p.dflt);
    return `<div class="st-pref"><div><b>${esc(p.label)}</b><div class="sub">${esc(p.sub)}</div></div><span class="st-step"><button data-dec="${p.key}">−</button>${v.toFixed(1)}×<button data-inc="${p.key}">+</button></span></div>`;
  }).join('');
  for (const b of document.querySelectorAll('[data-pref]')) b.onclick = () => { const on = b.classList.toggle('on'); localStorage.setItem(b.dataset.pref, on ? '1' : '0'); b.setAttribute('aria-checked', on); };
  for (const b of document.querySelectorAll('[data-dec],[data-inc]')) b.onclick = () => {
    const key = b.dataset.dec || b.dataset.inc;
    const p = PREFS.find((x) => x.key === key);
    let v = Number(localStorage.getItem(key) || p.dflt) + (b.dataset.inc ? p.step : -p.step);
    v = Math.min(p.max, Math.max(p.min, Math.round(v * 10) / 10));
    localStorage.setItem(key, String(v));
    renderPrefs();
  };
}

export function init(el) {
  host = el;
  // The page uses onboarding.css (.ob-* classes) which the app shell does not load — inject it once.
  if (!document.getElementById('view-settings-onboarding-css')) {
    const link = document.createElement('link');
    link.id = 'view-settings-onboarding-css';
    link.rel = 'stylesheet';
    link.href = 'onboarding.css';
    document.head.appendChild(link);
  }
  if (!document.getElementById('view-settings-css')) {
    const st = document.createElement('style');
    st.id = 'view-settings-css';
    st.textContent = SETTINGS_CSS;
    document.head.appendChild(st);
  }
  host.innerHTML = `
    <div class="st-wrap" data-st>
      <div class="st-head"><h1>Settings</h1></div>
      <nav class="st-nav" data-st-nav>
        <a href="#st-agents" class="active">Agents &amp; sign-in</a>
        <a href="#st-providers">API providers</a>
        <a href="#st-voice">Voice</a>
        <a href="#st-remote">Remote access</a>
        <a href="#st-prefs">Preferences</a>
      </nav>
      <div class="st-body">
      <section class="st-sec" id="st-agents" data-st-agents>
        <h2>Agents &amp; sign-in</h2>
        <div class="ob-card" id="st-authpath">loading…</div>
        <div class="ob-card" id="st-clis">loading…</div>
      </section>
      <section class="st-sec" id="st-providers" data-st-providers>
        <h2>API providers</h2>
        <div class="ob-card" id="st-prov">loading…</div>
      </section>
      <section class="st-sec" id="st-voice" data-st-voice>
        <h2>Voice</h2>
        <div class="ob-card" id="st-voicecard">loading…</div>
      </section>
      <section class="st-sec" id="st-remote" data-st-remote>
        <h2>Remote access</h2>
        <div class="ob-card" id="st-remotecard">loading…</div>
      </section>
      <section class="st-sec" id="st-prefs" data-st-prefs>
        <h2>Preferences</h2>
        <div class="ob-card" id="st-prefscard"></div>
      </section>
      </div>
    </div>`;

  // sticky sub-nav active state follows scroll
  const links = [...document.querySelectorAll('[data-st-nav] a')];
  onScroll = () => {
    let cur = links[0];
    for (const a of links) { const sec = document.querySelector(a.getAttribute('href')); if (sec && sec.getBoundingClientRect().top < 120) cur = a; }
    links.forEach((a) => a.classList.toggle('active', a === cur));
  };
  addEventListener('scroll', onScroll, { passive: true });

  loadAgents(); loadProviders(); loadVoice(); loadRemote(); renderPrefs();
}

export function teardown() {
  if (onScroll) removeEventListener('scroll', onScroll);
  onScroll = null;
  host = null;
}
