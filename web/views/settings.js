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
      /* add-provider form: one field per row — side-by-side 150px fields clipped their placeholders */
      .st-form-row .st-inp, .st-form-row .st-sel { min-width: 100%; }
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
    /* provider-centric voice: two capability rows (Speaks/Hears) + collapsed fallbacks + a providers table */
    .vc2-row { border: 1px solid #1d2632; border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; background: #0d1219; }
    .vc2-rowhead { font-size: 13.5px; color: #dde5ee; margin-bottom: 8px; }
    .vc2-rowhead b { font-weight: 600; }
    .vc2-sub { color: #5c6675; font-size: 12px; margin-left: 4px; }
    .vc2-primary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
    .vc2-primary > label { display: inline-flex; align-items: center; gap: 8px; color: #8a95a5; font-size: 12px; }
    .vc2-chain { color: #6cc04a; font-size: 12px; font-family: 'JetBrains Mono', ui-monospace, monospace; }
    .vc2-fb { margin-top: 8px; }
    .vc2-fb summary { color: #5c6675; font-size: 12px; cursor: pointer; user-select: none; }
    .vc2-fb summary:hover { color: #8a95a5; }
    .vc2-fbwrap { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 8px; }
    .vc2-fbchip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #b9c4d4; }
    .vc2-fbchip.dis { opacity: 0.5; }
    .vc2-cloud { color: #e2b23e; font-size: 10.5px; }
    .vc2-cap { font-size: 9px; font-weight: 800; letter-spacing: 0.04em; color: #79b8ff; border: 1px solid #79b8ff44; border-radius: 4px; padding: 0 4px; line-height: 15px; }
    .vc2-manage { margin-top: 6px; border-top: 1px solid #10151d; padding-top: 10px; }
    .vc2-manage > summary { color: #8a95a5; font-size: 13px; font-weight: 600; cursor: pointer; user-select: none; padding: 4px 0; }
    .vc2-manage > summary:hover { color: #dde5ee; }
    .vc2-provlist { display: grid; gap: 8px; margin-top: 8px; }
    .vc2-prov { border: 1px solid #1c2230; border-radius: 10px; padding: 10px 12px; background: #0b0f16; }
    .vc2-provhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; color: #dde5ee; }
    .vc2-provdetail { color: #5c6675; font-size: 11.5px; margin-left: auto; }
    .vc2-provbody { margin-top: 8px; }
    .vc2-provbody:empty { display: none; }
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

// ---- Provider-centric voice config (docs/specs/voice-providers-redesign.md) ---------------------
// Every source is a PROVIDER with capabilities; TTS and STT are chosen INDEPENDENTLY, each a primary +
// a collapsed fallback list. A "Manage providers" table configures each provider once. Replaces the old
// bundled 3-card + bolted-on dictation dropdown.
const SHORT_LABEL = { spark: 'Spark', codex: 'Codex', claude: 'Claude', cloud: 'Cloud', macos: 'macOS say', browser: 'Browser', 'match-agent': 'Match agent' };
const STATUS_META = {
  ok: { c: '#4ecb6c', t: 'READY' }, 'needs-signin': { c: '#e2b23e', t: 'SIGN IN' },
  'not-configured': { c: '#8a95a5', t: 'NOT SET' }, unavailable: { c: '#f2554d', t: 'UNAVAILABLE' },
};
const statusChip = (p) => { const s = STATUS_META[p.status] || STATUS_META['not-configured']; return `<span class="dk-chip" style="color:${s.c};border-color:${s.c}55">${s.t}</span>`; };
const capBadges = (p) => [p.caps.tts ? 'TTS' : '', p.caps.stt ? 'STT' : ''].filter(Boolean).map((c) => `<span class="vc2-cap">${c}</span>`).join('');
const resolvedText = (ids) => (ids.length ? ids.map((id) => SHORT_LABEL[id] || id).join(' → ') : '⚠ nothing available — configure a provider below');

function primaryOptions(cap, providers, sel) {
  const opts = [];
  if (cap === 'stt') opts.push(`<option value="match-agent"${sel.primary === 'match-agent' ? ' selected' : ''}>Match the session's agent</option>`);
  for (const p of providers) {
    const reason = p.available ? '' : ` — ${p.status === 'needs-signin' ? 'sign in first' : p.status === 'unavailable' ? p.detail : 'not configured'}`;
    opts.push(`<option value="${p.id}"${sel.primary === p.id ? ' selected' : ''}${p.available ? '' : ' disabled'}>${esc(p.label)}${esc(reason)}</option>`);
  }
  return opts.join('');
}
function fallbackChips(cap, providers, sel) {
  const rows = providers.filter((p) => p.id !== sel.primary).map((p) => {
    const on = sel.fallbacks.includes(p.id);
    const cloud = p.location === 'cloud';
    return `<label class="vc2-fbchip${p.available ? '' : ' dis'}"><input type="checkbox" data-fb="${cap}" data-pid="${p.id}"${on ? ' checked' : ''}${p.available ? '' : ' disabled'}/> ${esc(SHORT_LABEL[p.id] || p.label)}${cloud ? ' <span class="vc2-cloud">↗ sends audio to cloud</span>' : ''}</label>`;
  }).join('');
  return rows || '<span class="ob-fine">no other providers available</span>';
}
function capabilityRow(cap, title, sub, sel, providers, resolved) {
  return `
    <div class="vc2-row">
      <div class="vc2-rowhead"><b>${title}</b> <span class="vc2-sub">${sub}</span></div>
      <div class="vc2-primary">
        <label>Primary <select class="st-sel" id="vc2-${cap}-primary">${primaryOptions(cap, providers, sel)}</select></label>
        <span class="vc2-chain">${esc(resolvedText(resolved))}</span>
      </div>
      <details class="vc2-fb"><summary>Fallbacks</summary><div class="vc2-fbwrap">${fallbackChips(cap, providers, sel)}</div></details>
    </div>`;
}

// Per-provider config block for the Manage Providers table.
function cloudForm(sp) {
  return `<div class="st-form" id="st-sp-form" hidden>
    <input class="st-inp" id="st-sp-base" placeholder="Base URL (https://api.openai.com · http://127.0.0.1:8880 for Kokoro-FastAPI)" value="${esc(sp?.base_url || '')}" />
    <input class="st-inp" id="st-sp-sttbase" placeholder="STT base URL — only if dictation runs on a DIFFERENT server (blank = same)" value="${esc(sp?.stt_base_url || '')}" />
    <input class="st-inp" id="st-sp-key" type="password" placeholder="API key${sp?.key_set ? ' (saved — blank keeps it)' : ' (blank for local/open servers)'}" autocomplete="off" />
    <div class="st-form-row"><input class="st-inp" id="st-sp-sttm" placeholder="STT model (whisper-1)" value="${esc(sp?.stt_model || 'whisper-1')}" /><input class="st-inp" id="st-sp-ttsm" placeholder="TTS model (tts-1 · kokoro)" value="${esc(sp?.tts_model || 'tts-1')}" /><input class="st-inp" id="st-sp-voice" placeholder="TTS voice (alloy · af_heart)" value="${esc(sp?.tts_voice || 'alloy')}" /></div>
    <input class="st-inp" id="st-sp-instr" placeholder="Speaking style, optional (gpt-4o-mini-tts follows it)" value="${esc(sp?.tts_instructions || '')}" />
    <div class="st-form-row"><button class="dk-new sm" id="st-sp-save">Test &amp; save</button><button class="dk-reply-btn" id="st-sp-cancel">Cancel</button><span class="ob-msg" id="st-sp-msg"></span></div>
  </div>`;
}
function providerConfig(p, spk, sp) {
  if (p.id === 'spark') {
    if (!p.configured) return '<p class="ob-fine">Set SPARK_IP / SPARK_HOST in data/aios.env to add your local voice device (Whisper + Kokoro).</p>';
    const badge = (k) => (spk.overridden?.includes(k) ? '<span class="vc-badge ov">override</span>' : '<span class="vc-badge env">env</span>');
    const reset = (k) => (spk.overridden?.includes(k) ? `<button class="vc-reset" data-vc-reset="${k}" title="reset to the data/aios.env value">↺</button>` : '');
    const f = (id, label, val, key, ph) => `<div class="vc-field"><label>${label} ${badge(key)}${reset(key)}</label><input class="st-inp" id="${id}" value="${esc(val || '')}" placeholder="${esc(ph)}" data-vc-init="${esc(val || '')}" autocomplete="off" spellcheck="false" /></div>`;
    return `
      <div class="vc-field-grid">
        ${f('st-spark-host', 'Server host / SNI', spk.host, 'host', 'spark.your-tailnet.ts.net')}
        ${f('st-spark-ip', 'Server IP', spk.ip, 'ip', 'tailnet IP')}
        ${f('st-spark-engine', 'TTS engine', spk.ttsEngine, 'ttsEngine', 'kokoro · qwen')}
        ${f('st-spark-voice', 'TTS voice', spk.ttsVoice, 'ttsVoice', 'af_heart · Ryan')}
        ${f('st-spark-instr', 'Speaking style (optional)', spk.ttsInstruct, 'ttsInstruct', 'e.g. calm colleague giving a status report')}
      </div>
      <div class="vc-detail-actions">
        <button class="dk-reply-btn" id="st-spark-sample">▶ Play</button>
        <button class="dk-reply-btn" id="st-spark-stt">Test STT</button>
        <button class="dk-reply-btn" id="st-spark-health">Re-check</button>
        <span class="ob-msg" id="st-spark-msg" style="margin-left:auto"></span>
      </div>
      <div class="vc-dirty" id="st-spark-dirty" hidden><span class="ob-msg" id="st-spark-editmsg">Unsaved changes</span><button class="dk-reply-btn" id="st-spark-testdraft" style="margin-left:auto">Test draft</button><button class="dk-reply-btn" id="st-spark-discard">Discard</button><button class="dk-new sm" id="st-spark-save">Save</button></div>`;
  }
  if (p.id === 'codex') {
    return `<p class="ob-fine">${p.available ? 'Dictation runs through your own ChatGPT login. <b>Unofficial endpoint</b> — may change without notice; your audio goes to your ChatGPT account.' : 'Sign in to Codex to dictate from your ChatGPT subscription (no local Whisper needed).'} <a class="dk-reply-btn" href="auth">${p.available ? 'Re-login ▸' : 'Sign in ▸'}</a></p>`;
  }
  if (p.id === 'claude') {
    return "<p class=\"ob-fine\">Claude's dictation service is browser-gated (Cloudflare) with no supported headless API, so it can't run from the server. Nothing to configure — a Claude session uses the fallbacks above.</p>";
  }
  if (p.id === 'macos') {
    return '<div class="vc-detail-actions"><button class="dk-reply-btn" id="st-macos-test">▶ Play</button><span class="ob-msg" id="st-macos-msg"></span></div>';
  }
  if (p.id === 'browser') {
    return '<p class="ob-fine">On-device speech — no setup, instant, lower quality. Used when you pick it, or as the final fallback. Quality depends on your browser and OS voices.</p>';
  }
  if (p.id === 'cloud') {
    if (sp?.base_url) {
      return `
        <div class="ob-row"><span class="ob-ver">${esc(sp.base_url)} · STT ${esc(sp.stt_model || '—')} · TTS ${esc(sp.tts_model || '—')}/${esc(sp.tts_voice || '—')}${sp.key_set ? '' : ' · no key'}</span></div>
        <div class="vc-detail-actions"><button class="dk-reply-btn" id="st-sp-sample">▶ Play</button><button class="dk-reply-btn" id="st-sp-stt">Test STT</button><button class="dk-reply-btn" id="st-sp-edit-btn">Edit</button><button class="dk-reply-btn" id="st-sp-del" style="color:#f2554d;border-color:#f2554d55">Remove</button><span class="ob-msg" id="st-sp-rowmsg"></span></div>
        ${cloudForm(sp)}`;
    }
    return `<p class="ob-fine">An OpenAI-compatible endpoint (OpenAI · Groq · local Kokoro-FastAPI / speaches) adds cloud TTS + STT. <button class="dk-reply-btn" id="st-sp-add-btn">+ Add provider</button></p>${cloudForm(sp)}`;
  }
  return '';
}

async function loadVoice() {
  const host = $('#st-voicecard');
  if (!host) return;
  try {
    const [state, r] = await Promise.all([api('api/voice/state'), api('api/models/providers')]);
    if (!$('#st-voicecard')) return; // torn down mid-fetch
    const { providers, config: cfg, resolved } = state;
    const spk = r.spark || {};
    const sp = r.speech;
    const ttsP = providers.filter((p) => p.caps.tts);
    const sttP = providers.filter((p) => p.caps.stt);
    // Bridge to the client TTS stacks (they read localStorage.aios_tts): browser primary → device voice.
    try { localStorage.setItem('aios_tts', cfg.tts.primary === 'browser' ? 'browser' : 'neural'); } catch {}

    host.innerHTML = `
      ${capabilityRow('tts', '🔊 Speaks', 'reports &amp; voice replies', cfg.tts, ttsP, resolved.tts)}
      ${capabilityRow('stt', '🎙 Hears you', 'dictation to the agent', cfg.stt, sttP, resolved.stt)}
      <details class="vc2-manage"><summary>Manage providers</summary>
        <div class="vc2-provlist">
          ${providers.map((p) => `
            <div class="vc2-prov">
              <div class="vc2-provhead"><b>${esc(p.label)}</b> ${capBadges(p)} ${statusChip(p)}<span class="vc2-provdetail">${esc(p.detail || '')}</span></div>
              <div class="vc2-provbody">${providerConfig(p, spk, sp)}</div>
            </div>`).join('')}
        </div>
      </details>`;

    // ---- capability selection (primary + fallback checkboxes) ----
    const saveCap = async (cap) => {
      const primary = $(`#vc2-${cap}-primary`).value;
      const fallbacks = [...document.querySelectorAll(`input[data-fb="${cap}"]:checked`)].map((el) => el.dataset.pid);
      if (cap === 'tts') { try { localStorage.setItem('aios_tts', primary === 'browser' ? 'browser' : 'neural'); } catch {} }
      try { await api('api/voice/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [cap]: { primary, fallbacks } }) }); } catch {}
      loadVoice();
    };
    for (const cap of ['tts', 'stt']) {
      const primEl = $(`#vc2-${cap}-primary`);
      if (primEl) primEl.onchange = () => saveCap(cap);
      for (const cb of document.querySelectorAll(`input[data-fb="${cap}"]`)) cb.onchange = () => saveCap(cap);
    }

    // ---- provider config wiring ----
    wireSpark(spk);
    wireCloud(sp);
    const macTest = $('#st-macos-test');
    if (macTest) macTest.onclick = () => playTts($('#st-macos-msg'), { backend: 'local' });
  } catch (e) {
    if ($('#st-voicecard')) $('#st-voicecard').textContent = 'voice settings unavailable';
  }
}

// Spark provider config: inline dirty-tracked editor + tests + per-field env reset (unchanged behavior,
// just no longer gated behind a "card"). No-op if Spark isn't configured (no editor rendered).
function wireSpark(spk) {
  const m = $('#st-spark-msg');
  if (!m) return;
  const em = $('#st-spark-editmsg');
  $('#st-spark-sample') && ($('#st-spark-sample').onclick = () => playTts(m, { backend: 'spark' }));
  $('#st-spark-stt') && ($('#st-spark-stt').onclick = () => roundTripStt(m));
  $('#st-spark-health') && ($('#st-spark-health').onclick = async () => {
    m.textContent = 'checking…';
    try { const j = await api('api/spark/health'); m.textContent = j.status && j.status < 400 ? `✓ reachable (${esc(j.via || 'spark')})` : `⚠ ${esc(j.error || 'unreachable')}`; }
    catch (e) { m.textContent = '⚠ ' + (e.message || e); }
  });
  const FIELDS = { 'st-spark-host': 'host', 'st-spark-ip': 'ip', 'st-spark-engine': 'ttsEngine', 'st-spark-voice': 'ttsVoice', 'st-spark-instr': 'ttsInstruct' };
  const dirtyEl = $('#st-spark-dirty');
  const changed = () => Object.entries(FIELDS).filter(([id]) => { const el = $('#' + id); return el && el.value.trim() !== (el.dataset.vcInit || '').trim(); });
  const refresh = () => { if (dirtyEl) dirtyEl.hidden = changed().length === 0; };
  for (const id of Object.keys(FIELDS)) { const el = $('#' + id); if (el) el.oninput = refresh; }
  $('#st-spark-testdraft') && ($('#st-spark-testdraft').onclick = () => playTts(em, { backend: 'spark', engine: $('#st-spark-engine')?.value.trim() || undefined, voice: $('#st-spark-voice')?.value.trim() || undefined, instruct: $('#st-spark-instr')?.value.trim() || undefined }));
  $('#st-spark-discard') && ($('#st-spark-discard').onclick = () => loadVoice());
  $('#st-spark-save') && ($('#st-spark-save').onclick = async () => {
    const patch = Object.fromEntries(changed().map(([id, key]) => [key, $('#' + id).value.trim()]));
    if (!Object.keys(patch).length) { refresh(); return; }
    if (em) em.textContent = 'saving…';
    try { const j = await api('api/models/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }); if (!j.ok) throw new Error(j.error || 'failed'); loadVoice(); }
    catch (e) { if (em) em.textContent = '⚠ ' + (e.message || e); }
  });
  for (const b of document.querySelectorAll('[data-vc-reset]')) b.onclick = async () => {
    try { await api('api/models/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [b.dataset.vcReset]: '' }) }); loadVoice(); }
    catch (e) { if (m) m.textContent = '⚠ ' + (e.message || e); }
  };
}

// Cloud (OpenAI-compatible) provider config: add/edit form + tests + remove (unchanged behavior).
function wireCloud(sp) {
  const showForm = () => { const f = $('#st-sp-form'); if (f) { f.hidden = false; $('#st-sp-base')?.focus(); } };
  $('#st-sp-add-btn') && ($('#st-sp-add-btn').onclick = showForm);
  $('#st-sp-edit-btn') && ($('#st-sp-edit-btn').onclick = () => { const f = $('#st-sp-form'); if (f) f.hidden = !f.hidden; });
  $('#st-sp-cancel') && ($('#st-sp-cancel').onclick = () => { const f = $('#st-sp-form'); if (f) f.hidden = true; });
  $('#st-sp-save') && ($('#st-sp-save').onclick = async () => {
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
  });
  if (sp?.base_url) {
    const m = $('#st-sp-rowmsg');
    $('#st-sp-sample') && ($('#st-sp-sample').onclick = () => playTts(m, { backend: 'provider' }));
    $('#st-sp-stt') && ($('#st-sp-stt').onclick = () => roundTripStt(m, 'provider'));
    armConfirm($('#st-sp-del'), 'Confirm remove', async () => { await api('api/models/speech', { method: 'DELETE' }).catch(() => {}); loadVoice(); });
  }
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
