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

// ---- Voice ---------------------------------------------------------------------------------------
async function loadVoice() {
  try {
    const r = await api('api/models/providers');
    const sp = r.speech;
    const provRow = sp?.base_url
      ? `<div class="ob-row"><b>${esc(sp.base_url)}</b><span class="ob-ver">STT ${esc(sp.stt_model || '—')} · TTS ${esc(sp.tts_model || '—')} · voice ${esc(sp.voice || '—')}</span><a class="dk-reply-btn" href="auth">Edit ▸</a></div>`
      : `<p class="ob-fine">No cloud speech provider — voice falls back to the browser's built-in speech. <a class="dk-reply-btn" href="auth">Configure ▸</a> or run onboarding step 3.</p>`;
    $('#st-voicecard').innerHTML = `<div id="st-stt"></div>${provRow}`;
    await loadSttSource();
  } catch (e) { $('#st-voicecard').textContent = 'unavailable'; }
}

// Dictation source picker: which speech-to-text powers the mic. Default "auto" matches the session's
// agent (a Codex session dictates via your own Codex login, etc.), falling back to local Whisper.
async function loadSttSource() {
  const host = $('#st-stt');
  if (!host) return;
  let s;
  try { s = await api('api/stt/sources'); } catch { host.innerHTML = ''; return; }
  const av = s.sources || {};
  const opt = (val, label, ok, note) =>
    `<option value="${val}"${s.pref === val ? ' selected' : ''}${ok ? '' : ' disabled'}>${label}${ok ? '' : ` — ${note}`}</option>`;
  host.innerHTML = `
    <div class="ob-row"><b>Dictation (speech-to-text)</b>
      <select id="st-stt-sel" class="dk-reply-btn" style="padding:4px 8px">
        ${opt('auto', 'Auto — match the session agent', true)}
        ${opt('codex', 'Codex (your ChatGPT login)', av.codex, 'sign in to Codex')}
        ${opt('claude', 'Claude', av.claude, 'coming soon')}
        ${opt('spark', 'Local Whisper (Spark)', av.spark, 'not configured')}
        ${opt('provider', 'Cloud provider', av.provider, 'not configured')}
      </select>
      <span class="ob-msg" id="st-stt-msg"></span>
    </div>
    <p class="ob-fine">Auto uses the CLI you're signed into — a Codex session transcribes through your own ChatGPT account (the Codex app's private endpoint, not an official API), a Claude session through Claude. Local Whisper stays fully on-device and never leaves your machine. Falls back automatically if a source is down.</p>`;
  $('#st-stt-sel').onchange = async (e) => {
    const msg = $('#st-stt-msg'); msg.textContent = 'saving…';
    try { await api('api/models/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sttSource: e.target.value }) }); msg.textContent = '✓'; setTimeout(() => (msg.textContent = ''), 1500); }
    catch (err) { msg.textContent = '⚠ ' + (err.message || err); }
  };
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
