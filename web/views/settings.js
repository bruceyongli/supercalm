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
    /* config forms (voice / API providers — migrated from the auth page) */
    .st-form { display: grid; gap: 8px; margin-top: 10px; }
    .st-form-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .st-form-row .st-inp { flex: 1; min-width: 150px; }
    .st-inp, .st-sel { background: #0b0f16; border: 1px solid #232c38; border-radius: 8px; color: #dde5ee; font-size: 12.5px; padding: 8px 10px; width: 100%; box-sizing: border-box; font-family: 'JetBrains Mono', ui-monospace, monospace; }
    .st-inp::placeholder { color: #3f4856; }
    .st-sel { width: auto; }
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

// ---- API providers (management migrated from the auth page — no bounce-out) -----------------------
async function loadProviders() {
  try {
    const r = await api('api/models/providers');
    if (!host) return; // torn down mid-fetch
    const box = $('#st-prov');
    const builtin = (r.builtin || []).map((p) => `
      <div class="ob-row" data-proxy="${esc(p.id.replace('builtin:', ''))}"><b>${esc(p.name)}</b>
        <span class="ob-ver">built-in · ${esc(p.base_url || '')} · ${(p.models || []).length} models · key auto</span>
        <label class="ob-ver" style="margin-left:auto;cursor:pointer"><input type="checkbox" data-act="bi-toggle" ${p.enabled ? 'checked' : ''}/> use</label>
      </div>`).join('');
    const rows = (r.providers || []).map((p) => `
      <div class="ob-row" data-id="${esc(p.id)}"><b>${esc(p.name)}</b>
        <span class="ob-ver">${esc(p.kind)} · ${esc(p.base_url || '')} · ${(p.models || []).length} models · ${p.key_set ? 'key set' : 'no key'}</span>
        <button class="dk-reply-btn" data-act="test">Test</button>
        <button class="dk-reply-btn" data-act="del">Remove</button>
        <span class="ob-msg" data-role="msg"></span>
      </div>`).join('');
    const pr = r.pricing || {};
    box.innerHTML = `${builtin}${rows || (builtin ? '' : '<p class="ob-fine">No API providers yet — add one below to use API models without a local proxy fleet.</p>')}
      <div class="st-form">
        <div class="st-form-row">
          <select class="st-sel" id="st-ap-kind">
            <option value="anthropic">Anthropic API (serves claude sessions + agents)</option>
            <option value="openai">OpenAI-compatible API (any /v1/chat/completions endpoint)</option>
          </select>
          <input class="st-inp" id="st-ap-name" placeholder="Name (e.g. Anthropic, OpenRouter)" />
        </div>
        <input class="st-inp" id="st-ap-base" placeholder="Base URL — blank = https://api.anthropic.com" />
        <div class="st-form-row">
          <input class="st-inp" id="st-ap-key" type="password" placeholder="API key (blank for open/local endpoints)" autocomplete="off" />
          <input class="st-inp" id="st-ap-models" placeholder="Models (comma-separated; blank = auto-discover)" />
          <button class="dk-reply-btn" id="st-ap-add">Test &amp; add</button>
        </div>
        <span class="ob-msg" id="st-ap-msg"></span>
      </div>
      <div class="ob-row" style="margin-top:10px"><b>Cost stats</b><span class="ob-ver">${pr.configured ? `✓ ${pr.count} priced models (${esc(pr.source_kind || '')})` : 'optional — point at a price manifest for $ estimates on Usage'}</span></div>
      <div class="st-form-row">
        <input class="st-inp" id="st-price-url" placeholder="Price manifest URL (Supercalm / LiteLLM shapes)" value="${esc(pr.configured ? pr.url : '')}" />
        <button class="dk-reply-btn" id="st-price-set">Set</button>
        <button class="dk-reply-btn" id="st-price-ours" title="${esc(pr.suggested_url || '')}">Use Supercalm's list</button>
        ${pr.configured ? '<button class="dk-reply-btn" id="st-price-clear">Clear</button>' : ''}
        <span class="ob-msg" id="st-price-msg"></span>
      </div>`;
    for (const row of box.querySelectorAll('[data-proxy]')) {
      row.querySelector('[data-act="bi-toggle"]').onchange = async (e) => {
        await api(`api/models/providers/builtin/${row.dataset.proxy}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: e.target.checked }) }).catch(() => {});
        api('api/models/refresh', { method: 'POST' }).catch(() => {});
      };
    }
    for (const row of box.querySelectorAll('[data-id]')) {
      const id = row.dataset.id;
      const m = row.querySelector('[data-role="msg"]');
      row.querySelector('[data-act="test"]').onclick = async () => {
        m.textContent = 'testing…';
        try { const j = await api(`api/models/providers/${id}/test`, { method: 'POST' }); m.textContent = j.ok ? `✓ ${j.models.length} models` : '⚠ ' + j.error; }
        catch (e) { m.textContent = '⚠ ' + (e.message || e); }
      };
      row.querySelector('[data-act="del"]').onclick = async () => { await api(`api/models/providers/${id}`, { method: 'DELETE' }).catch(() => {}); loadProviders(); };
    }
    $('#st-ap-kind').onchange = () => {
      $('#st-ap-base').placeholder = $('#st-ap-kind').value === 'anthropic' ? 'Base URL — blank = https://api.anthropic.com' : 'Base URL (e.g. https://api.openai.com or https://openrouter.ai/api)';
    };
    $('#st-ap-add').onclick = async () => {
      const msg = $('#st-ap-msg');
      msg.textContent = 'testing…';
      try {
        const body = {
          kind: $('#st-ap-kind').value, name: $('#st-ap-name').value.trim(), base_url: $('#st-ap-base').value.trim(),
          api_key: $('#st-ap-key').value, models: $('#st-ap-models').value.split(',').map((x) => x.trim()).filter(Boolean),
        };
        const j = await api('api/models/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (!j.ok) throw new Error(j.error || 'failed');
        msg.textContent = '✓ added';
        loadProviders();
      } catch (e) { msg.textContent = '⚠ ' + (e.message || e); }
    };
    const priceMsg = $('#st-price-msg');
    const setPrice = async (u) => {
      priceMsg.textContent = 'fetching…';
      try {
        const j = await api('api/models/pricing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: u }) });
        if (!j.ok) throw new Error(j.error || 'failed');
        priceMsg.textContent = `✓ ${j.count} models`;
        setTimeout(loadProviders, 600);
      } catch (e) { priceMsg.textContent = '⚠ ' + (e.message || e); }
    };
    $('#st-price-set').onclick = () => setPrice($('#st-price-url').value.trim());
    $('#st-price-ours').onclick = () => setPrice('');
    const pc = $('#st-price-clear');
    if (pc) pc.onclick = async () => { await api('api/models/pricing', { method: 'DELETE' }).catch(() => {}); loadProviders(); };
  } catch (e) { if (host) $('#st-prov').textContent = 'unavailable: ' + (e.message || e); }
}

// ---- Voice — the FULL speech-provider config lives here now (migrated off the auth page). ---------
// One OpenAI-compatible audio endpoint covers GPT TTS + STT (or Groq/local Kokoro-FastAPI/speaches):
// once saved, /api/tts and /api/transcribe use it AUTOMATICALLY (Spark device, when set, speaks
// first; the provider is the fallback — and the only path on Spark-less installs).
async function loadVoice() {
  try {
    const r = await api('api/models/providers');
    if (!host) return; // torn down mid-fetch
    const sp = r.speech;
    const spark = !!r.spark_configured;
    const path = sp?.base_url
      ? (spark ? 'Spark device is configured — it speaks first; this provider is the automatic fallback for both TTS and STT.'
               : 'No Spark device — this provider handles all TTS and STT automatically.')
      : (spark ? 'Spark device handles voice. Add a provider as an automatic fallback (or for use away from the device).' : '');
    $('#st-voicecard').innerHTML = `
      ${sp?.base_url ? `
      <div class="ob-row"><b>Speech provider</b>
        <span class="ob-ver">${esc(sp.base_url)} · STT ${esc(sp.stt_model || '—')} · TTS ${esc(sp.tts_model || '—')}/${esc(sp.tts_voice || '—')}${sp.key_set ? '' : ' · no key'}</span>
        <button class="dk-reply-btn" id="st-sp-sample">▶ Play sample</button>
        <button class="dk-reply-btn" id="st-sp-stt">Test STT</button>
        <button class="dk-reply-btn" id="st-sp-del">Remove</button>
        <span class="ob-msg" id="st-sp-rowmsg"></span>
      </div>` : `<p class="ob-fine">Not configured — without a Spark device, voice falls back to the browser's built-in speech and server STT is unavailable. Add any OpenAI-compatible audio endpoint (OpenAI, Groq, local Kokoro-FastAPI / speaches).</p>`}
      ${path ? `<p class="ob-fine">${esc(path)}</p>` : ''}
      <div class="st-form">
        <input class="st-inp" id="st-sp-base" placeholder="Base URL (https://api.openai.com · http://127.0.0.1:8880 for Kokoro-FastAPI)" value="${esc(sp?.base_url || '')}" />
        <input class="st-inp" id="st-sp-key" type="password" placeholder="API key${sp?.key_set ? ' (saved — blank keeps it)' : ' (blank for local/open servers)'}" autocomplete="off" />
        <div class="st-form-row">
          <input class="st-inp" id="st-sp-sttm" placeholder="STT model (whisper-1 · gpt-4o-mini-transcribe)" value="${esc(sp?.stt_model || 'whisper-1')}" />
          <input class="st-inp" id="st-sp-ttsm" placeholder="TTS model (tts-1 · gpt-4o-mini-tts · kokoro)" value="${esc(sp?.tts_model || 'tts-1')}" />
          <input class="st-inp" id="st-sp-voice" placeholder="TTS voice (alloy · af_heart)" value="${esc(sp?.tts_voice || 'alloy')}" />
        </div>
        <input class="st-inp" id="st-sp-instr" placeholder="Speaking style, optional (models like gpt-4o-mini-tts follow it — e.g. calm colleague giving a status report)" value="${esc(sp?.tts_instructions || '')}" />
        <div class="st-form-row"><button class="dk-reply-btn" id="st-sp-save">Test &amp; save</button><span class="ob-msg" id="st-sp-msg"></span></div>
      </div>`;
    $('#st-sp-save').onclick = async () => {
      const msg = $('#st-sp-msg');
      msg.textContent = 'testing tts…';
      try {
        const j = await api('api/models/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          base_url: $('#st-sp-base').value.trim(), api_key: $('#st-sp-key').value,
          stt_model: $('#st-sp-sttm').value.trim(), tts_model: $('#st-sp-ttsm').value.trim(),
          tts_voice: $('#st-sp-voice').value.trim(), tts_instructions: $('#st-sp-instr').value.trim(),
        }) });
        if (!j.ok) throw new Error(j.error || 'failed');
        msg.textContent = '✓ saved';
        loadVoice();
      } catch (e) { msg.textContent = '⚠ ' + (e.message || e); }
    };
    if (sp?.base_url) {
      const m = $('#st-sp-rowmsg');
      $('#st-sp-del').onclick = async () => { await api('api/models/speech', { method: 'DELETE' }).catch(() => {}); loadVoice(); };
      // Hear what the SYSTEM will actually speak (full chain incl. Spark precedence) + name the backend.
      $('#st-sp-sample').onclick = async () => {
        m.textContent = 'synthesizing…';
        try {
          const r2 = await fetch('api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Voice check — this is how your reports will sound.' }) });
          if (!r2.ok) throw new Error('HTTP ' + r2.status);
          const src = r2.headers.get('x-tts-backend') || r2.headers.get('x-aios-tts-source') || '?';
          const a = new Audio(URL.createObjectURL(await r2.blob()));
          a.onended = () => { m.textContent = `✓ spoke via ${src}`; };
          m.textContent = `playing (via ${src})…`;
          await a.play();
        } catch (e) { m.textContent = '⚠ ' + (e.message || e); }
      };
      // Round-trip: provider TTS a phrase, feed the audio back through provider STT — proves BOTH
      // gpt tts + gpt stt work with the saved key, no microphone needed.
      $('#st-sp-stt').onclick = async () => {
        m.textContent = 'round-trip: synthesizing…';
        try {
          const t = await fetch('api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'voice check one two three', backend: 'provider' }) });
          if (!t.ok) throw new Error('tts HTTP ' + t.status);
          const audio = await t.blob();
          m.textContent = 'round-trip: transcribing…';
          const s = await fetch('api/transcribe?backend=provider&polish=false', { method: 'POST', headers: { 'content-type': audio.type || 'audio/mpeg' }, body: audio });
          const j = await s.json().catch(() => ({}));
          if (!s.ok) throw new Error(j.error || 'stt HTTP ' + s.status);
          m.textContent = `✓ STT heard: “${(j.text || '').slice(0, 60)}”`;
        } catch (e) { m.textContent = '⚠ ' + (e.message || e); }
      };
    }
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
