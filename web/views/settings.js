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
    .st-wrap { width: 100%; max-width: 1080px; margin: 0 auto; padding: 32px; display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 30px; align-items: start; }
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
      .st-nav a { border: 1px solid #232c38; border-radius: 999px; padding: 8px 12px; min-height: 38px; display: inline-flex; align-items: center; }
      /* provider rows: name + "use" toggle on the first line, the long endpoint details wrap
         full-width below (the desktop three-across row crushed into unreadable columns) */
      #st-prov .ob-row { flex-wrap: wrap; row-gap: 4px; }
      #st-prov .ob-row span.ob-ver { flex: 1 1 100%; order: 3; }
      #st-prov .ob-row label.ob-ver { flex: 0 0 auto; }
      #st-prov .ob-row input[type="checkbox"] { width: 19px; height: 19px; }
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
    /* voice chooser — one question ("which voice?"), one tap per answer */
    .vc-status { display: flex; flex-wrap: wrap; gap: 6px 18px; color: #8a95a5; font-size: 12.5px; margin: 2px 0 12px; }
    .vc-status b { color: #dde5ee; font-weight: 600; }
    .vc-cards { display: grid; gap: 8px; }
    .vc-card { border: 1px solid #232c38; border-radius: 12px; padding: 12px 14px; cursor: pointer; background: #0d1219; display: grid; gap: 4px; }
    .vc-card:hover { border-color: #2f3b4c; }
    .vc-card.on { border-color: #58a6ff; background: #0f1622; cursor: default; }
    .vc-head { display: flex; align-items: center; gap: 10px; }
    .vc-dot { width: 16px; height: 16px; border-radius: 99px; border: 2px solid #3a4453; flex-shrink: 0; box-sizing: border-box; }
    .vc-card.on .vc-dot { border-color: #58a6ff; }
    .vc-card.on .vc-dot::after { content: ''; display: block; width: 8px; height: 8px; margin: 2px; border-radius: 99px; background: #58a6ff; }
    .vc-title { font-weight: 600; color: #dde5ee; font-size: 13.5px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .vc-sub { color: #5c6675; font-size: 12px; line-height: 1.5; padding-left: 26px; }
    .vc-body { display: grid; gap: 8px; padding: 8px 0 2px 26px; }
    .vc-adv { margin-top: 14px; }
    .vc-adv summary { color: #5c6675; font-size: 12px; cursor: pointer; user-select: none; }
    .vc-adv summary:hover { color: #8a95a5; }
    /* inline voice editing (gpt redesign): the active card expands to prefilled, always-editable fields */
    .vc-field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; margin: 6px 0 2px; }
    .vc-field { display: grid; gap: 4px; min-width: 0; }
    .vc-field.full { grid-column: 1 / -1; }
    .vc-field > label { display: flex; align-items: center; gap: 7px; color: #8a95a5; font-size: 11.5px; }
    .vc-badge { font-size: 9px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; border: 1px solid; border-radius: 4px; padding: 0 5px; line-height: 15px; white-space: nowrap; }
    .vc-badge.env { color: #5c6675; border-color: #2a3341; }
    .vc-badge.ov { color: #e2b23e; border-color: #e2b23e55; }
    .vc-reset { margin-left: auto; background: none; border: 0; color: #e2b23e; cursor: pointer; font-size: 14px; padding: 0 2px; line-height: 1; }
    .vc-reset:hover { color: #f0c869; }
    .vc-field-ro { background: #0b0f16; border: 1px solid #1b2430; border-radius: 8px; color: #8a95a5; font-size: 12.5px; padding: 8px 10px; font-family: 'JetBrains Mono', ui-monospace, monospace; }
    .vc-detail-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; align-items: center; }
    .vc-dirty { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; padding: 8px 10px; border: 1px solid #e2b23e33; background: #e2b23e0f; border-radius: 9px; }
    .vc-dirty[hidden] { display: none; }
    .vc-fallbacks { margin-top: 16px; padding-top: 12px; border-top: 1px solid #10151d; }
    .vc-fallbacks h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #5c6675; margin: 0 0 8px; font-weight: 600; }
    .vc-fallbacks .ob-row { flex-wrap: wrap; row-gap: 6px; }
    @media (max-width: 720px) { .vc-field-grid { grid-template-columns: 1fr; } } /* stack fields on phone/narrow */
    /* config forms (voice / API providers — migrated from the auth page) */
    .st-form { display: grid; gap: 8px; margin-top: 10px; }
    .st-form[hidden] { display: none; } /* [hidden] UA rule loses to .st-form's explicit display — restore it so Edit/Add toggles work */
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
      const versionOrInstall = t.current
        ? `<span class="ob-ver">${esc(t.current)}</span>${t.latest && t.latest !== t.current ? `<span class="dk-chip" style="color:#e2b23e;border-color:#e2b23e55">${esc(t.latest)} AVAILABLE</span><button class="dk-reply-btn" data-up="${esc(t.id)}">Update</button>` : ''}`
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
// Play the FULL TTS chain and report which backend spoke (reused by Spark + cloud rows).
async function playTts(m, body = {}) {
  m.textContent = 'synthesizing…';
  try {
    const r2 = await fetch('api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Voice check — this is how your reports will sound.', ...body }) });
    if (!r2.ok) throw new Error('HTTP ' + r2.status);
    const src = r2.headers.get('x-tts-backend') || r2.headers.get('x-aios-tts-source') || '?';
    const a = new Audio(URL.createObjectURL(await r2.blob()));
    a.onended = () => { m.textContent = `✓ spoke via ${src}`; };
    m.textContent = `playing (via ${src})…`;
    await a.play();
  } catch (e) { m.textContent = '⚠ ' + (e.message || e); }
}
// Round-trip STT: synthesize a phrase, feed the audio back through STT (no mic needed).
async function roundTripStt(m, backend) {
  m.textContent = 'round-trip: synthesizing…';
  try {
    const q = backend ? `?backend=${backend}` : '';
    const t = await fetch('api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'voice check one two three', ...(backend ? { backend } : {}) }) });
    if (!t.ok) throw new Error('tts HTTP ' + t.status);
    const audio = await t.blob();
    m.textContent = 'round-trip: transcribing…';
    const s = await fetch(`api/transcribe${q}${q ? '&' : '?'}polish=false`, { method: 'POST', headers: { 'content-type': audio.type || 'audio/mpeg' }, body: audio });
    const j = await s.json().catch(() => ({}));
    if (!s.ok) throw new Error(j.error || 'stt HTTP ' + s.status);
    m.textContent = `✓ STT heard: “${(j.text || '').slice(0, 60)}”`;
  } catch (e) { m.textContent = '⚠ ' + (e.message || e); }
}
// Two-click inline confirm (no modal): first click arms + shows a confirm label, second within 3s runs.
function armConfirm(btn, confirmLabel, fn) {
  if (!btn) return;
  const orig = btn.textContent; let armed = false, t;
  btn.onclick = () => {
    if (armed) { clearTimeout(t); btn.textContent = orig; armed = false; fn(); return; }
    armed = true; btn.textContent = confirmLabel;
    t = setTimeout(() => { armed = false; btn.textContent = orig; }, 3000);
  };
}

// Which "voice choice" the current server state amounts to. One of: local | gpt | browser.
// "local" covers BOTH flavors of self-hosted voice: the env-configured dedicated device and
// OpenAI-compatible local servers — users think "local voice", not our device codename.
function voiceChoice(spk, sp) {
  if (spk?.configured && spk.enabled !== false) return 'local';
  if (sp?.base_url) return /^https:\/\/api\.(openai|groq)\.com/.test(sp.base_url) || (/^https:/.test(sp.base_url) && sp.key_set) ? 'gpt' : 'local';
  return 'browser';
}
// Combined one-tap check for the ACTIVE voice: play a sample, then round-trip STT — one message.
async function testVoice(m, backend) {
  m.textContent = 'testing…';
  try {
    const body = { text: 'Voice check — this is how your reports will sound.', ...(backend ? { backend } : {}) };
    const t = await fetch('api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!t.ok) throw new Error('speak failed: HTTP ' + t.status);
    const src = t.headers.get('x-tts-backend') || t.headers.get('x-aios-tts-source') || '?';
    const audio = await t.blob();
    const a = new Audio(URL.createObjectURL(audio));
    m.textContent = `speaking (${src})…`;
    await a.play().catch(() => {});
    const q = backend ? `?backend=${backend}&polish=false` : '?polish=false';
    const s = await fetch(`api/transcribe${q}`, { method: 'POST', headers: { 'content-type': audio.type || 'audio/mpeg' }, body: audio });
    const j = await s.json().catch(() => ({}));
    m.textContent = s.ok
      ? `✓ speaks (${src}) · hears you (${j.backend || '?'}): “${(j.text || '').slice(0, 42)}”`
      : `✓ speaks (${src}) · ⚠ dictation: ${(j.error || 'HTTP ' + s.status).slice(0, 80)}`;
  } catch (e) { m.textContent = '⚠ ' + (e.message || e); }
}

let vcOpen = null; // which card's setup form is open ('gpt' | 'local' | null) — survives re-renders

// Dictation source = which STT powers the mic (subscription from your CLI login vs local Whisper vs
// cloud). Independent of the TTS "voice choice" cards below. Default auto = match the session's agent.
function sttSourceBlock(stt) {
  if (!stt) return '';
  const av = stt.sources || {};
  const opt = (val, label, ok, note) =>
    `<option value="${val}"${stt.pref === val ? ' selected' : ''}${ok ? '' : ' disabled'}>${label}${ok ? '' : ` — ${note}`}</option>`;
  return `
    <div class="vc-stt">
      <div class="st-form-row">
        <label for="st-stt-sel" style="font-weight:600">🎙 Dictation source</label>
        <select class="st-sel" id="st-stt-sel">
          ${opt('auto', 'Auto — match the session agent', true)}
          ${opt('codex', 'Codex — your ChatGPT login', av.codex, 'sign in to Codex')}
          ${opt('claude', 'Claude', av.claude, 'coming soon')}
          ${opt('spark', 'Local Whisper (Spark)', av.spark, 'not configured')}
          ${opt('provider', 'Cloud provider', av.provider, 'not configured')}
        </select>
        <span class="ob-msg" id="st-stt-msg"></span>
      </div>
      <p class="ob-fine" style="margin:6px 0 0">Auto uses the CLI you're signed into — a Codex session transcribes through your own ChatGPT account via the Codex app's private endpoint (unofficial, not a public API), a Claude session through Claude. Local Whisper stays fully on-device. Falls back automatically if a source is down.</p>
    </div>`;
}

async function loadVoice() {
  try {
    const [r, stt] = await Promise.all([api('api/models/providers'), api('api/stt/sources').catch(() => null)]);
    if (!host) return; // torn down mid-fetch
    const sp = r.speech;
    const spk = r.spark || { configured: !!r.spark_configured };
    const spark = !!spk.configured;
    const enabled = spk.enabled !== false;
    const ov = (k) => spk.overridden?.includes(k);
    const choice = voiceChoice(spk, sp);
    const openCard = vcOpen || choice; // the active choice shows its details; a tapped card shows its setup

    const deviceActive = spark && enabled; // env-configured dedicated local voice server, currently in use

    // ---- one-line truth: what speaks, what listens (no architecture vocabulary) ----
    const speakDesc = {
      gpt: `GPT · ${esc(sp?.tts_model || '')}/${esc(sp?.tts_voice || '')}`,
      local: deviceActive ? `local ${esc(spk.ttsEngine || 'kokoro')}/${esc(spk.ttsVoice || 'af_heart')}` : `local ${esc(sp?.tts_model || 'kokoro')}/${esc(sp?.tts_voice || 'af_heart')}`,
      browser: 'this device',
    }[choice];
    const hearDesc = { gpt: 'OpenAI Whisper', local: 'local Whisper', browser: 'off — browser dictation only' }[choice];

    // ---- the three choices ----
    const card = (id, title, sub, chips, body) => `
      <div class="vc-card${choice === id ? ' on' : ''}" data-vc="${id}" role="radio" aria-checked="${choice === id}">
        <div class="vc-head"><span class="vc-dot"></span><span class="vc-title">${title}${chips || ''}</span></div>
        <div class="vc-sub">${sub}</div>
        ${openCard === id && body ? `<div class="vc-body">${body}</div>` : ''}
      </div>`;
    const inUse = '<span class="dk-chip" style="color:#4ecb6c;border-color:#4ecb6c55">IN USE</span>';
    const testRow = (id) => choice === id ? `<div class="st-form-row"><button class="dk-reply-btn" data-vc-test="${id}">▶ Test voice</button><span class="ob-msg" id="st-vc-msg-${id}"></span></div>` : '';

    const localSelected = choice === 'local';
    // Per-field source badge + reset (gpt: show current values, mark env vs override, no blank-to-inherit).
    const vcBadge = (key) => ov(key) ? '<span class="vc-badge ov">overridden</span>' : '<span class="vc-badge env">from env</span>';
    const vcReset = (key) => ov(key) ? `<button class="vc-reset" data-vc-reset="${key}" title="reset to the data/aios.env value" aria-label="reset to env">↺</button>` : '';
    const sField = (id, label, val, key, ph, full) => `
      <div class="vc-field${full ? ' full' : ''}">
        <label for="${id}">${label} ${vcBadge(key)}${vcReset(key)}</label>
        <input class="st-inp" id="${id}" value="${esc(val || '')}" placeholder="${esc(ph)}" data-vc-init="${esc(val || '')}" autocomplete="off" spellcheck="false" />
      </div>`;
    // The dedicated local voice server (env-configured): its real settings, PREFILLED + editable inline —
    // no "Advanced", no "Edit" toggle, no empty fields (operator: "the info is not there"). gpt design.
    const localDetail = `
      <div class="vc-field-grid">
        ${sField('st-spark-host', 'Server host / SNI', spk.host, 'host', 'spark.your-tailnet.ts.net')}
        ${sField('st-spark-ip', 'Server IP', spk.ip, 'ip', 'tailnet IP')}
        ${sField('st-spark-engine', 'TTS engine', spk.ttsEngine, 'ttsEngine', 'kokoro · qwen')}
        ${sField('st-spark-voice', 'TTS voice', spk.ttsVoice, 'ttsVoice', 'af_heart · am_michael · Ryan')}
        ${sField('st-spark-instr', 'Speaking style (optional)', spk.ttsInstruct, 'ttsInstruct', 'e.g. calm colleague giving a status report', true)}
        <div class="vc-field"><label>Dictation (STT)</label><div class="vc-field-ro">${esc(spk.sttModel || 'whisper-1')} · local Whisper</div></div>
      </div>
      <div class="vc-detail-actions">
        <button class="dk-reply-btn" id="st-spark-sample">▶ Play</button>
        <button class="dk-reply-btn" id="st-spark-stt">Test STT</button>
        <button class="dk-reply-btn" id="st-spark-health">Re-check</button>
        <span class="ob-msg" id="st-spark-msg" style="margin-left:auto"></span>
      </div>
      <div class="vc-dirty" id="st-spark-dirty" hidden>
        <span class="ob-msg" id="st-spark-editmsg">Unsaved changes</span>
        <button class="dk-reply-btn" id="st-spark-testdraft" style="margin-left:auto">Test draft</button>
        <button class="dk-reply-btn" id="st-spark-discard">Discard</button>
        <button class="dk-new sm" id="st-spark-save">Save changes</button>
      </div>
      <p class="ob-fine" style="margin:8px 0 0">Edits save as a local override in data/model_providers.json over data/aios.env — hot-reloaded, no restart. ↺ resets a field to its env value.</p>`;
    const localBody = deviceActive
      ? localDetail
      : `${localSelected ? '' : `
        <input class="st-inp" id="st-vc-lspeak" placeholder="Speak — Kokoro-FastAPI URL (http://127.0.0.1:8880)" value="${esc((choice !== 'gpt' && sp?.base_url) || '')}" />
        <input class="st-inp" id="st-vc-lhear" placeholder="Listen — Whisper server URL (blank = same server, e.g. speaches does both)" value="${esc(sp?.stt_base_url || '')}" />
        <div class="st-form-row">
          <button class="dk-new sm" data-vc-save="local">Save &amp; use local voice</button>
          <span class="ob-msg" id="st-vc-lmsg"></span>
        </div>
        <p class="ob-fine" style="margin:0">Defaults: kokoro/af_heart + whisper-1${spark ? '; switch back to your local device anytime' : ''}.</p>`}
      ${testRow('local')}`;
    const localCard = card('local', 'Local voice (Whisper + Kokoro)',
      'Self-hosted voice models on your own hardware — private and free.',
      localSelected ? inUse : '', localBody);

    const gptSelected = choice === 'gpt';
    const gptCard = card('gpt', 'GPT voice (OpenAI)',
      'OpenAI’s cloud voices + Whisper dictation. Needs only your API key.',
      gptSelected ? inUse : '',
      `${gptSelected ? '' : `
        <input class="st-inp" id="st-vc-gptkey" type="password" placeholder="OpenAI API key (sk-…)" autocomplete="off" />
        <div class="st-form-row">
          <select class="st-sel" id="st-vc-gptvoice">${['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map((v) => `<option${v === 'alloy' ? ' selected' : ''}>${v}</option>`).join('')}</select>
          <button class="dk-new sm" data-vc-save="gpt">Save &amp; use GPT voice</button>
          <span class="ob-msg" id="st-vc-gptmsg"></span>
        </div>
        <p class="ob-fine" style="margin:0">Uses gpt-4o-mini-tts + whisper-1${spark ? '; your local voice steps aside (switch back anytime)' : ''}. Fine-tune models under advanced.</p>`}
      ${testRow('gpt')}`);

    const browserCard = card('browser', 'Browser only',
      'No setup. This device reads aloud with its built-in voice; server dictation stays off.',
      choice === 'browser' ? '<span class="dk-chip" style="color:#8a95a5;border-color:currentColor">IN USE</span>' : '',
      choice === 'browser' ? '' : '<div class="st-form-row"><button class="dk-reply-btn" data-vc-save="browser">Turn server voice off</button><span class="ob-msg" id="st-vc-bmsg"></span></div>');

    $('#st-voicecard').innerHTML = `
      <div class="vc-status"><span>🔊 Speaks with <b>${speakDesc}</b></span><span>🎙 Hears you via <b>${hearDesc}</b></span></div>
      ${sttSourceBlock(stt)}
      <div class="vc-cards" role="radiogroup" aria-label="Voice choice">${localCard}${gptCard}${browserCard}</div>
      <div class="vc-fallbacks">
        <h3>Fallbacks &amp; providers</h3>
      ${spark ? `
      <div class="ob-row"><b>Local say</b>
        <span class="dk-chip" style="color:#8a95a5;border-color:currentColor">FALLBACK · TTS</span>
        <span class="ob-ver">macOS say · 127.0.0.1:${esc(String(spk.localTtsPort || 17071))} · voice ${esc(spk.localVoice || 'alloy')} · built-in, used only if the voice server is unreachable</span>
      </div>` : ''}
      ${sp?.base_url ? `
      <div class="ob-row"><b>Speech provider</b>
        <span class="dk-chip" style="color:#4ecb6c;border-color:#4ecb6c55">READY · TTS + STT</span>
        <span class="ob-ver">${esc(sp.base_url)} · STT ${esc(sp.stt_model || '—')} · TTS ${esc(sp.tts_model || '—')}/${esc(sp.tts_voice || '—')}${sp.key_set ? '' : ' · no key'}</span>
        <button class="dk-reply-btn" id="st-sp-sample">▶ Play</button>
        <button class="dk-reply-btn" id="st-sp-stt">Test STT</button>
        <button class="dk-reply-btn" id="st-sp-edit-btn">Edit</button>
        <button class="dk-reply-btn" id="st-sp-del" style="color:#f2554d;border-color:#f2554d55">Remove</button>
        <span class="ob-msg" id="st-sp-rowmsg"></span>
      </div>` : `
      <div class="ob-row"><b>Speech provider</b>
        <span class="dk-chip" style="color:#8a95a5;border-color:currentColor">NOT CONFIGURED</span>
        <span class="ob-ver">OpenAI-compatible TTS + STT (OpenAI · Groq · local Kokoro-FastAPI / speaches)${spark ? '' : ' — without it and without Spark, voice falls back to the browser'}</span>
        <button class="dk-reply-btn" id="st-sp-add-btn">+ Add provider</button>
      </div>`}
      <div class="st-form" id="st-sp-form" hidden>
        <input class="st-inp" id="st-sp-base" placeholder="Base URL (https://api.openai.com · http://127.0.0.1:8880 for Kokoro-FastAPI)" value="${esc(sp?.base_url || '')}" />
        <input class="st-inp" id="st-sp-sttbase" placeholder="STT base URL — only if dictation runs on a DIFFERENT server (blank = same)" value="${esc(sp?.stt_base_url || '')}" />
        <input class="st-inp" id="st-sp-key" type="password" placeholder="API key${sp?.key_set ? ' (saved — blank keeps it)' : ' (blank for local/open servers)'}" autocomplete="off" />
        <div class="st-form-row">
          <input class="st-inp" id="st-sp-sttm" placeholder="STT model (whisper-1 · gpt-4o-mini-transcribe)" value="${esc(sp?.stt_model || 'whisper-1')}" />
          <input class="st-inp" id="st-sp-ttsm" placeholder="TTS model (tts-1 · gpt-4o-mini-tts · kokoro)" value="${esc(sp?.tts_model || 'tts-1')}" />
          <input class="st-inp" id="st-sp-voice" placeholder="TTS voice (alloy · af_heart)" value="${esc(sp?.tts_voice || 'alloy')}" />
        </div>
        <input class="st-inp" id="st-sp-instr" placeholder="Speaking style, optional (gpt-4o-mini-tts follows it — e.g. calm colleague giving a status report)" value="${esc(sp?.tts_instructions || '')}" />
        <div class="st-form-row"><button class="dk-new sm" id="st-sp-save">Test &amp; save</button><button class="dk-reply-btn" id="st-sp-cancel">Cancel</button><span class="ob-msg" id="st-sp-msg"></span></div>
      </div>
      </div>`;

    // ---- dictation source picker (independent of the TTS voice cards) ----
    const sttSel = document.querySelector('#st-stt-sel');
    if (sttSel) sttSel.onchange = async () => {
      const msg = document.querySelector('#st-stt-msg'); if (msg) msg.textContent = 'saving…';
      try { await api('api/models/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sttSource: sttSel.value }) }); if (msg) { msg.textContent = '✓'; setTimeout(() => (msg.textContent = ''), 1500); } }
      catch (err) { if (msg) msg.textContent = '⚠ ' + (err.message || err); }
    };

    // ---- choice cards: one tap = the system switches (fallbacks stay automatic underneath) ----
    for (const c of document.querySelectorAll('[data-vc]')) {
      c.onclick = async (e) => {
        if (e.target.closest('button, input, select, a, [data-vc-save], [data-vc-test]')) return; // controls inside the card
        const id = c.dataset.vc;
        if (id === choice) { if (vcOpen) { vcOpen = null; loadVoice(); } return; } // re-tapping the active choice closes any open setup
        if (id === 'local' && spark) { // the dedicated local device is already configured — switching back is instant
          try { await api('api/models/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sparkDisabled: false }) }); vcOpen = null; loadVoice(); } catch {}
          return;
        }
        vcOpen = id; // gpt/local/browser need their one-step setup first — open it
        loadVoice();
      };
    }
    const vcApply = async (msgEl, speechBody) => {
      msgEl.textContent = 'testing…';
      const j = await api('api/models/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(speechBody) });
      if (!j.ok) throw new Error(j.error || 'failed');
      if (spark && enabled) await api('api/models/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sparkDisabled: true }) });
      vcOpen = null;
      loadVoice();
    };
    const gptSave = document.querySelector('[data-vc-save="gpt"]');
    if (gptSave) gptSave.onclick = async () => {
      const m = $('#st-vc-gptmsg');
      try {
        const key = $('#st-vc-gptkey').value.trim();
        if (!key) { m.textContent = '⚠ paste your OpenAI API key'; return; }
        await vcApply(m, { base_url: 'https://api.openai.com', stt_base_url: '', api_key: key, stt_model: 'whisper-1', tts_model: 'gpt-4o-mini-tts', tts_voice: $('#st-vc-gptvoice').value });
      } catch (e) { m.textContent = '⚠ ' + (e.message || e); }
    };
    const localSave = document.querySelector('[data-vc-save="local"]');
    if (localSave) localSave.onclick = async () => {
      const m = $('#st-vc-lmsg');
      try {
        const speak = $('#st-vc-lspeak').value.trim();
        if (!speak) { m.textContent = '⚠ enter the Kokoro-FastAPI URL'; return; }
        await vcApply(m, { base_url: speak, stt_base_url: $('#st-vc-lhear').value.trim(), api_key: '', stt_model: 'whisper-1', tts_model: 'kokoro', tts_voice: 'af_heart' });
      } catch (e) { m.textContent = '⚠ ' + (e.message || e); }
    };
    const browserSave = document.querySelector('[data-vc-save="browser"]');
    if (browserSave) armConfirm(browserSave, 'Confirm — turn server voice off', async () => {
      try {
        await api('api/models/speech', { method: 'DELETE' }).catch(() => {});
        if (spark && enabled) await api('api/models/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sparkDisabled: true }) });
        vcOpen = null;
        loadVoice();
      } catch {}
    });
    for (const b of document.querySelectorAll('[data-vc-test]')) {
      // the dedicated device speaks through the default chain; URL-based local + GPT test the provider path
      b.onclick = () => testVoice($(`#st-vc-msg-${b.dataset.vcTest}`), b.dataset.vcTest === 'local' && deviceActive ? undefined : 'provider');
    }

    // ---- Local voice server: inline, always-editable fields (only when it's the active choice) ----
    if (spark && deviceActive) {
      const m = $('#st-spark-msg');
      const em = $('#st-spark-editmsg');
      $('#st-spark-sample') && ($('#st-spark-sample').onclick = () => playTts(m));
      $('#st-spark-stt') && ($('#st-spark-stt').onclick = () => roundTripStt(m));
      $('#st-spark-health') && ($('#st-spark-health').onclick = async () => {
        m.textContent = 'checking…';
        try { const j = await api('api/spark/health'); m.textContent = j.status && j.status < 400 ? `✓ reachable (${esc(j.via || 'spark')})` : `⚠ ${esc(j.error || 'unreachable')}`; }
        catch (e) { m.textContent = '⚠ ' + (e.message || e); }
      });
      // Dirty-state editing: fields are prefilled with the effective config; the Save bar appears only once
      // a field actually changes, and Save sends ONLY the changed fields (so an env-inherited field isn't
      // turned into a needless override just by saving).
      const FIELDS = { 'st-spark-host': 'host', 'st-spark-ip': 'ip', 'st-spark-engine': 'ttsEngine', 'st-spark-voice': 'ttsVoice', 'st-spark-instr': 'ttsInstruct' };
      const dirtyEl = $('#st-spark-dirty');
      const changed = () => Object.entries(FIELDS).filter(([id]) => { const el = $('#' + id); return el && el.value.trim() !== (el.dataset.vcInit || '').trim(); });
      const refreshDirty = () => { if (dirtyEl) dirtyEl.hidden = changed().length === 0; };
      for (const id of Object.keys(FIELDS)) { const el = $('#' + id); if (el) el.oninput = refreshDirty; }
      $('#st-spark-testdraft') && ($('#st-spark-testdraft').onclick = () => playTts(em, { engine: $('#st-spark-engine')?.value.trim() || undefined, voice: $('#st-spark-voice')?.value.trim() || undefined, instruct: $('#st-spark-instr')?.value.trim() || undefined }));
      $('#st-spark-discard') && ($('#st-spark-discard').onclick = () => loadVoice());
      $('#st-spark-save') && ($('#st-spark-save').onclick = async () => {
        const patch = Object.fromEntries(changed().map(([id, key]) => [key, $('#' + id).value.trim()]));
        if (!Object.keys(patch).length) { refreshDirty(); return; }
        if (em) em.textContent = 'saving…';
        try { const j = await api('api/models/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }); if (!j.ok) throw new Error(j.error || 'failed'); loadVoice(); }
        catch (e) { if (em) em.textContent = '⚠ ' + (e.message || e); }
      });
      // Per-field reset: clear just that field's override -> re-inherit the data/aios.env value.
      for (const b of document.querySelectorAll('[data-vc-reset]')) b.onclick = async () => {
        try { await api('api/models/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [b.dataset.vcReset]: '' }) }); loadVoice(); }
        catch (e) { if (m) m.textContent = '⚠ ' + (e.message || e); }
      };
    }

    // ---- Cloud fallback provider actions ----
    const showForm = () => { $('#st-sp-form').hidden = false; $('#st-sp-base')?.focus(); };
    $('#st-sp-add-btn') && ($('#st-sp-add-btn').onclick = showForm);
    $('#st-sp-edit-btn') && ($('#st-sp-edit-btn').onclick = () => { const f = $('#st-sp-form'); f.hidden = !f.hidden; });
    $('#st-sp-cancel') && ($('#st-sp-cancel').onclick = () => { if (sp?.base_url || spark) $('#st-sp-form').hidden = true; });
    $('#st-sp-save').onclick = async () => {
      const msg = $('#st-sp-msg'); msg.textContent = 'testing tts…';
      try {
        const j = await api('api/models/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          base_url: $('#st-sp-base').value.trim(), stt_base_url: $('#st-sp-sttbase').value.trim(), api_key: $('#st-sp-key').value,
          stt_model: $('#st-sp-sttm').value.trim(), tts_model: $('#st-sp-ttsm').value.trim(),
          tts_voice: $('#st-sp-voice').value.trim(), tts_instructions: $('#st-sp-instr').value.trim(),
        }) });
        if (!j.ok) throw new Error(j.error || 'failed');
        msg.textContent = '✓ saved'; loadVoice();
      } catch (e) { msg.textContent = '⚠ ' + (e.message || e); }
    };
    if (sp?.base_url) {
      const m = $('#st-sp-rowmsg');
      $('#st-sp-sample').onclick = () => playTts(m, { backend: 'provider' });
      $('#st-sp-stt').onclick = () => roundTripStt(m, 'provider');
      armConfirm($('#st-sp-del'), 'Confirm remove', async () => { await api('api/models/speech', { method: 'DELETE' }).catch(() => {}); loadVoice(); });
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
  { key: 'aios_release_notify', label: 'Release notifications', sub: 'reload nudge when a new version deploys. Stable only skips routine auto-deploys; Off silences them entirely.', type: 'select', options: [['stable', 'Stable only'], ['every', 'Every release'], ['off', 'Off']], dflt: 'stable' },
];
function renderPrefs() {
  $('#st-prefscard').innerHTML = PREFS.map((p) => {
    if (p.type === 'toggle') {
      const on = localStorage.getItem(p.key) == null ? !!p.dflt : localStorage.getItem(p.key) === '1';
      return `<div class="st-pref"><div><b>${esc(p.label)}</b><div class="sub">${esc(p.sub)}</div></div><button class="st-toggle${on ? ' on' : ''}" data-pref="${p.key}" role="switch" aria-checked="${on}"></button></div>`;
    }
    if (p.type === 'select') {
      const cur = localStorage.getItem(p.key) || p.dflt;
      const opts = p.options.map(([v, lbl]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(lbl)}</option>`).join('');
      return `<div class="st-pref"><div><b>${esc(p.label)}</b><div class="sub">${esc(p.sub)}</div></div><select class="st-sel" data-pref-sel="${p.key}">${opts}</select></div>`;
    }
    const v = Number(localStorage.getItem(p.key) || p.dflt);
    return `<div class="st-pref"><div><b>${esc(p.label)}</b><div class="sub">${esc(p.sub)}</div></div><span class="st-step"><button data-dec="${p.key}">−</button>${v.toFixed(1)}×<button data-inc="${p.key}">+</button></span></div>`;
  }).join('');
  for (const b of document.querySelectorAll('[data-pref]')) b.onclick = () => { const on = b.classList.toggle('on'); localStorage.setItem(b.dataset.pref, on ? '1' : '0'); b.setAttribute('aria-checked', on); };
  for (const s of document.querySelectorAll('[data-pref-sel]')) s.onchange = () => localStorage.setItem(s.dataset.prefSel, s.value);
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
