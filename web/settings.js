// Settings (design handoff): sticky sub-nav, 1:1 homes for every onboarding step, real endpoints.
import { api, escapeHtml as esc } from './common.js';
const $ = (s) => document.querySelector(s);

// ---- Agents & sign-in --------------------------------------------------------------------------
async function loadAgents() {
  try {
    const st = await api('api/auth/status');
    $('#st-authpath').innerHTML = `
      <div class="ob-row"><b>Session auth path</b><span class="dk-chip" style="color:#79b8ff;border-color:#79b8ff55">${esc((st.mode || '?').toUpperCase())}</span>
      <span class="ob-ver">${st.proxyUp ? '● proxy reachable' : 'no local proxy'}</span>
      <button class="dk-reply-btn" id="st-recheck">Re-check proxy</button></div>
      <p class="ob-fine">Sessions auto-detect their auth: an external proxy if present, else Supercalm's own login via a local shim, else the CLI's own login.</p>`;
    $('#st-recheck').onclick = loadAgents;
    // r4 4b: ONE merged card per CLI — install/version state + login state together, never two rows.
    let tools = [];
    try { tools = (await api('api/tools/versions')).tools || []; } catch {}
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
  } catch (e) { $('#st-authpath').textContent = 'unavailable: ' + (e.message || e); }
}

// ---- API providers -------------------------------------------------------------------------------
async function loadProviders() {
  try {
    const r = await api('api/models/providers');
    const builtin = (r.builtin || []).map((p) => `<div class="ob-row"><b>${esc(p.name)}</b><span class="ob-ver">built-in · ${(p.models || []).length} models · key auto</span><span class="dk-chip" style="color:${p.enabled ? '#4ecb6c' : '#8a95a5'};border-color:currentColor">${p.enabled ? 'ON' : 'OFF'}</span></div>`).join('');
    const rows = (r.providers || []).map((p) => `<div class="ob-row"><b>${esc(p.name)}</b><span class="ob-ver">${esc(p.kind)} · ${(p.models || []).length} models · ${p.key_set ? 'key set' : 'no key'}</span></div>`).join('');
    const pr = r.pricing || {};
    $('#st-prov').innerHTML = `${builtin}${rows || (builtin ? '' : '<p class="ob-fine">No API providers yet.</p>')}
      <div class="ob-row"><b>Cost stats</b><span class="ob-ver">${pr.configured ? `✓ ${pr.count} priced models` : 'not configured (optional)'}</span><a class="dk-reply-btn" href="auth">Manage ▸</a></div>`;
  } catch (e) { $('#st-prov').textContent = 'unavailable: ' + (e.message || e); }
}

// ---- Voice (classic page — the SPA settings view has the full provider table) --------------------
// Two capability picks: Speaks (TTS) + Hears you (STT), from the provider-centric model. Full provider
// config (Spark host/voice, cloud key, sign-in) lives in the SPA Voice view.
async function loadVoice() {
  const card = $('#st-voicecard');
  if (!card) return;
  try {
    const state = await api('api/voice/state');
    if (!$('#st-voicecard')) return;
    const { providers, config, resolved } = state;
    const ttsP = providers.filter((p) => p.caps.tts);
    const sttP = providers.filter((p) => p.caps.stt);
    const opts = (cap, list, sel) => {
      const o = [];
      if (cap === 'stt') o.push(`<option value="match-agent"${sel.primary === 'match-agent' ? ' selected' : ''}>Match the session's agent</option>`);
      for (const p of list) o.push(`<option value="${p.id}"${sel.primary === p.id ? ' selected' : ''}${p.available ? '' : ' disabled'}>${esc(p.label)}${p.available ? '' : ' — ' + esc(p.status === 'unavailable' ? p.detail : p.status === 'needs-signin' ? 'sign in' : 'not configured')}</option>`);
      return o.join('');
    };
    const row = (cap, label, sel, list, res) => `
      <div class="ob-row"><b>${label}</b>
        <select id="st-${cap}-sel" class="dk-reply-btn" style="padding:4px 8px">${opts(cap, list, sel)}</select>
        <span class="ob-ver">${esc(res.map((id) => ({ spark: 'Spark', codex: 'Codex', cloud: 'Cloud', macos: 'macOS', browser: 'Browser' }[id] || id)).join(' → ') || '⚠ none available')}</span>
        <span class="ob-msg" id="st-${cap}-msg"></span>
      </div>`;
    card.innerHTML = `
      ${row('tts', '🔊 Speaks', config.tts, ttsP, resolved.tts)}
      ${row('stt', '🎙 Hears you', config.stt, sttP, resolved.stt)}
      <p class="ob-fine">Configure providers (Spark, Codex sign-in, cloud key) and fallbacks in the <a class="dk-reply-btn" href="settings">full Voice settings</a>. Claude dictation is browser-gated and unavailable from the server.</p>`;
    for (const cap of ['tts', 'stt']) {
      const sel = $(`#st-${cap}-sel`);
      if (sel) sel.onchange = async () => {
        const msg = $(`#st-${cap}-msg`); if (msg) msg.textContent = 'saving…';
        if (cap === 'tts') { try { localStorage.setItem('aios_tts', sel.value === 'browser' ? 'browser' : 'neural'); } catch {} }
        try { await api('api/voice/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [cap]: { primary: sel.value } }) }); if (msg) { msg.textContent = '✓'; setTimeout(() => (msg.textContent = ''), 1200); } loadVoice(); }
        catch (err) { if (msg) msg.textContent = '⚠ ' + (err.message || err); }
      };
    }
  } catch (e) { card.textContent = 'unavailable'; }
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

// sticky sub-nav active state follows scroll
const links = [...document.querySelectorAll('[data-st-nav] a')];
addEventListener('scroll', () => {
  let cur = links[0];
  for (const a of links) { const sec = document.querySelector(a.getAttribute('href')); if (sec && sec.getBoundingClientRect().top < 120) cur = a; }
  links.forEach((a) => a.classList.toggle('active', a === cur));
}, { passive: true });

loadAgents(); loadProviders(); loadVoice(); loadRemote(); renderPrefs();
