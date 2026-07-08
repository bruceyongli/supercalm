// Multi-provider auth: claude session mode + per-provider dashboard login. All URLs relative.
const $ = (id) => document.getElementById(id);
const MODE_DESC = {
  proxy: 'Routing through the local proxy fleet (127.0.0.1:8789). Dashboard-managed, auto-refreshing.',
  aios: 'Routing through Supercalm’s own login + local shim. Supercalm holds + auto-refreshes the credential.',
  cli: 'Using the Claude CLI’s own ~/.claude login (no proxy, no Supercalm login).',
  pinned: 'Pinned to AIOS_CLAUDE_BASE_URL (explicit override).',
  api: 'Routing through your configured API model provider (Auth & Models below) — no fleet, no OAuth needed.',
};
// Per-provider copy: what a login enables + how to grab the code from the callback page.
const INFO = {
  claude: {
    enables: 'Serves Supercalm claude sessions (via the local shim when there’s no proxy) and the proxy — same shared credential. Kills the ~8h re-login.',
    callback: 'Approve, then the page shows <code>CODE#STATE</code> — copy the whole thing.',
  },
  codex: {
    enables: 'Writes <code>~/.codex/auth.json</code> (the Codex CLI default) — serves Supercalm codex sessions AND the proxy directly.',
    callback: 'Approve, then the <code>localhost:1455</code> page won’t load — copy the <code>code</code> value from the address bar (or paste the whole URL).',
  },
  antigravity: {
    enables: 'Writes <code>~/.antigravity-proxy/oauth_creds.json</code> for the local proxy. Supercalm checks <code>agy</code> separately because the CLI owns its own keyring/SSH token store.',
    callback: 'Approve, then the <code>localhost:51121</code> page won’t load — copy the <code>code</code> value from the address bar (or paste the whole URL).',
  },
};
const nonces = {};

function fmtExpiry(s) {
  if (s == null) return '—';
  if (s <= 0) return 'expired';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `in ${h}h ${m}m` : `in ${m}m`;
}
async function api(path, opts) {
  const r = await fetch(path, opts);
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { error: t || r.statusText }; }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function providerCard(p) {
  const info = INFO[p.id] || {};
  const statePill = p.loggedIn ? '<span class="pill ok">logged in</span>' : '<span class="pill out">not logged in</span>';
  const acct = p.account ? `<div class="row"><span class="k">Account</span><span class="v">${esc(p.account)}</span></div>` : '';
  const exp = p.loggedIn ? `<div class="row"><span class="k">Token</span><span class="v">${fmtExpiry(p.expiresInSec)}${p.refreshable ? '' : ' · refreshed by its CLI/proxy'}</span></div>` : '';
  const linked =
    p.id === 'antigravity' && ('proxyLoggedIn' in p || 'cliLoggedIn' in p)
      ? `<div class="row"><span class="k">Status</span><span class="v">proxy ${p.proxyLoggedIn ? 'ok' : 'missing'} · agy CLI ${p.cliLoggedIn ? 'signed in' : 'not signed in'}</span></div>`
      : '';
  const hasAnyLogin = p.loggedIn || p.proxyLoggedIn || p.cliLoggedIn;
  const logoutBtn = hasAnyLogin ? `<button class="btn ghost sm" data-act="logout" data-p="${p.id}">Log out</button>` : '';
  const refreshBtn = p.loggedIn && p.refreshable ? `<button class="btn ghost sm" data-act="refresh" data-p="${p.id}">Refresh token</button>` : '';
  return `
    <div class="card prov" style="border-left-color:${p.color || '#30363d'}">
      <h2><span style="color:${p.color}">●</span> ${esc(p.label)} ${statePill}</h2>
      <p class="hint">${info.enables || ''}</p>
      ${acct}${linked}${exp}
      <details ${p.loggedIn ? '' : 'open'}>
        <summary>${p.loggedIn ? 'Re-login' : 'Log in'}</summary>
        <ol class="steps">
          <li>Open the authorize page (new tab).
            <div class="btnrow"><button class="btn sm" data-act="start" data-p="${p.id}">Start login →</button></div>
            <div class="hidden" data-url="${p.id}"><div class="hint" style="margin-top:6px">If it didn’t open:</div><a class="au" target="_blank" rel="noopener"></a></div>
          </li>
          <li>${info.callback || 'Approve and copy the code.'}</li>
          <li>Paste it here.
            <input data-code="${p.id}" placeholder="paste the code (or full callback URL)" autocomplete="off" />
            <div class="btnrow"><button class="btn sm" data-act="complete" data-p="${p.id}">Complete login</button>${refreshBtn}${logoutBtn}</div>
          </li>
        </ol>
        <div class="msg" data-msg="${p.id}"></div>
      </details>
    </div>`;
}

function setMsg(pid, text, kind) {
  const m = document.querySelector(`[data-msg="${pid}"]`);
  if (m) { m.textContent = text || ''; m.className = 'msg' + (kind ? ' ' + kind : ''); }
}

async function refreshStatus() {
  let s;
  try { s = await api('api/auth/status'); } catch (e) { $('modeDesc').textContent = 'status error: ' + e.message; return; }
  const pill = $('modePill');
  pill.textContent = (s.mode || '?').toUpperCase();
  pill.className = 'pill mode-' + (s.mode || 'cli');
  $('modeDesc').textContent = MODE_DESC[s.mode] || s.mode;
  $('proxyDot').className = 'dot ' + (s.proxyUp ? 'up' : 'down');
  $('proxyTxt').textContent = s.proxyUp ? 'reachable' : 'not found';
  $('proxyUrl').textContent = s.proxyUrl || '';
  // preserve any text the user is mid-typing
  const typed = {};
  document.querySelectorAll('[data-code]').forEach((i) => { if (i.value) typed[i.getAttribute('data-code')] = i.value; });
  $('providers').innerHTML = (s.providers || []).map(providerCard).join('');
  for (const [pid, v] of Object.entries(typed)) { const i = document.querySelector(`[data-code="${pid}"]`); if (i) i.value = v; }
}

// ---- CLI tools & models (version check / one-click update / model rescan) ----
function toolRow(t) {
  const cur = t.current ? esc(t.current) : '<span class="pill out">not found</span>';
  let status = '';
  if (t.updateAvailable) status = ` <span class="pill warn">${esc(t.latest)} available</span> <button class="btn sm" data-upd="${t.id}">Update</button>`;
  else if (t.current && t.latest) status = ' <span class="pill ok">latest</span>';
  else if (t.current) status = ` <span class="hint">no registry feed</span> <button class="btn ghost sm" data-upd="${t.id}">Run updater</button>`;
  return `<div class="row"><span class="k">${esc(t.label)}</span><span class="v">${cur}${status}</span></div>`;
}

function renderTools(r) {
  $('toolRows').innerHTML = (r.tools || []).map(toolRow).join('');
  const m = r.models || {};
  const added = (m.added || []).length
    ? ` · <b>+${m.added.length} new:</b> ${m.added.slice(0, 5).map((a) => esc(a.label || a.id)).join(', ')}${m.added.length > 5 ? '…' : ''}`
    : '';
  $('modelsInfo').innerHTML =
    `${m.modelCount ?? '—'} models · scanned ${m.scannedAt ? new Date(m.scannedAt).toLocaleString() : 'never (static list)'}` + added;
}

function toolsMsg(text, kind) {
  const el = $('toolsMsg');
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

async function refreshTools() {
  try { renderTools(await api('api/tools/versions')); } catch (e) { toolsMsg(e.message, 'err'); }
}

$('checkTools').onclick = async () => {
  const b = $('checkTools');
  b.disabled = true;
  toolsMsg('checking registries + rescanning the proxy fleet…');
  try {
    const r = await api('api/tools/check', { method: 'POST' });
    renderTools(r);
    const fresh = (r.tools || []).filter((t) => t.updateAvailable).length;
    toolsMsg(fresh ? `${fresh} update(s) available` : 'CLIs up to date · model catalog rescanned', 'ok');
  } catch (e) { toolsMsg(e.message, 'err'); }
  b.disabled = false;
};

document.addEventListener('click', async (e) => {
  const upd = e.target.closest('[data-upd]');
  if (upd) {
    const id = upd.getAttribute('data-upd');
    if (!confirm(`Update ${id} now? Running sessions keep their current binary until relaunched.`)) return;
    upd.disabled = true;
    upd.textContent = 'updating…';
    toolsMsg(`running ${id} updater…`);
    try {
      const r = await api(`api/tools/${id}/update`, { method: 'POST' });
      toolsMsg(r.changed ? `${id}: ${r.from} → ${r.to} ✓` : r.ok ? `${id}: already ${r.to || r.from}` : `${id}: updater failed — ${String(r.output || '').slice(-200)}`, r.ok ? 'ok' : 'err');
      await refreshTools();
    } catch (err) { toolsMsg(err.message, 'err'); upd.disabled = false; upd.textContent = 'Update'; }
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (btn) {
    const pid = btn.getAttribute('data-p');
    const act = btn.getAttribute('data-act');
    if (act === 'start') {
      setMsg(pid, 'starting…');
      try {
        const r = await api(`api/auth/${pid}/start`, { method: 'POST' });
        nonces[pid] = r.nonce;
        const box = document.querySelector(`[data-url="${pid}"]`);
        const a = box.querySelector('a'); a.href = r.authorizeUrl; a.textContent = r.authorizeUrl;
        box.classList.remove('hidden');
        window.open(r.authorizeUrl, '_blank', 'noopener');
        setMsg(pid, 'Approve in the opened tab, then paste the code.', 'ok');
      } catch (err) { setMsg(pid, err.message, 'err'); }
    } else if (act === 'complete') {
      const code = (document.querySelector(`[data-code="${pid}"]`) || {}).value?.trim();
      if (!code) return setMsg(pid, 'paste the code first', 'err');
      setMsg(pid, 'exchanging…');
      try {
        const r = await api(`api/auth/${pid}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, nonce: nonces[pid] }) });
        const agyPartial = pid === 'antigravity' && r.proxyLoggedIn && !r.cliLoggedIn;
        const label = agyPartial ? 'proxy logged in ✓' : 'logged in ✓';
        const agyNote = agyPartial ? ' · agy CLI still needs `agy` login' : '';
        setMsg(pid, label + (r.account ? ' · ' + r.account : '') + agyNote, r.loggedIn ? 'ok' : 'err');
        await refreshStatus();
      } catch (err) { setMsg(pid, err.message, 'err'); }
    } else if (act === 'logout') {
      if (!confirm(`Log out ${pid}?`)) return;
      try { await api(`api/auth/${pid}/logout`, { method: 'POST' }); await refreshStatus(); } catch (err) { setMsg(pid, err.message, 'err'); }
    } else if (act === 'refresh') {
      setMsg(pid, 'refreshing…');
      try { const r = await api(`api/auth/${pid}/refresh`, { method: 'POST' }); setMsg(pid, r.deferred ? r.note : 'refreshed ✓', 'ok'); await refreshStatus(); } catch (err) { setMsg(pid, err.message, 'err'); }
    }
  }
});

$('reprobe').onclick = async () => { try { await api('api/auth/probe', { method: 'POST' }); await refreshStatus(); } catch (e) {} };

refreshStatus();
refreshTools();
setInterval(refreshStatus, 25000);


// ---- API model providers (model_providers.js) ----------------------------------------------------
// The no-local-fleet path: add an Anthropic/OpenAI(-compatible) endpoint + key; its models join the
// catalog (pickers, supervisor chains), and an anthropic-kind provider can serve claude sessions.
async function loadApiProviders() {
  const box = $('apiProviders');
  if (!box) return;
  let r;
  try { r = await api('api/models/providers'); } catch (e) { box.innerHTML = `<p class="muted">unavailable: ${e.message}</p>`; return; }
  const rows = (r.providers || []).map((p) => `
    <div class="prov-row" data-id="${p.id}">
      <b>${esc(p.name)}</b>
      <span class="muted">${esc(p.kind)} · ${esc(p.base_url)} · ${(p.models || []).length} models${p.key_set ? '' : ' · <span style="color:#f85149">no key</span>'}</span>
      <button class="btn sm ghost" data-act="test">Test</button>
      <button class="btn sm ghost" data-act="del">Remove</button>
      <span class="muted" data-role="msg"></span>
    </div>`).join('');
  box.innerHTML = `
    ${rows || '<p class="muted">No API providers yet — add one below to use API models without a local proxy fleet.</p>'}
    <div class="prov-add">
      <select id="ap-kind">
        <option value="anthropic">Anthropic API (serves claude sessions + agents)</option>
        <option value="openai">OpenAI-compatible API (agents; any /v1/chat/completions endpoint)</option>
      </select>
      <input id="ap-name" placeholder="Name (e.g. Anthropic, OpenRouter)" />
      <input id="ap-base" placeholder="Base URL — blank = https://api.anthropic.com" />
      <input id="ap-key" type="password" placeholder="API key" autocomplete="off" />
      <input id="ap-models" placeholder="Models (comma-separated; blank = auto-discover)" />
      <button class="btn sm" id="ap-add">Test & add</button>
      <span class="muted" id="ap-msg"></span>
    </div>`;
  $('ap-kind').onchange = () => {
    $('ap-base').placeholder = $('ap-kind').value === 'anthropic' ? 'Base URL — blank = https://api.anthropic.com' : 'Base URL (e.g. https://api.openai.com or https://openrouter.ai/api)';
  };
  $('ap-add').onclick = async () => {
    const msg = $('ap-msg');
    msg.textContent = 'testing…';
    try {
      const body = {
        kind: $('ap-kind').value, name: $('ap-name').value.trim(), base_url: $('ap-base').value.trim(),
        api_key: $('ap-key').value, models: $('ap-models').value.split(',').map((x) => x.trim()).filter(Boolean),
      };
      const j = await api('api/models/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!j.ok) throw new Error(j.error || 'failed');
      msg.textContent = '✓ added';
      loadApiProviders();
    } catch (e) { msg.textContent = '⚠ ' + e.message; }
  };
  for (const row of box.querySelectorAll('.prov-row')) {
    const id = row.dataset.id;
    const m = row.querySelector('[data-role="msg"]');
    row.querySelector('[data-act="test"]').onclick = async () => {
      m.textContent = 'testing…';
      try { const j = await api(`api/models/providers/${id}/test`, { method: 'POST' }); m.textContent = j.ok ? `✓ ${j.models.length} models` : '⚠ ' + j.error; }
      catch (e) { m.textContent = '⚠ ' + e.message; }
    };
    row.querySelector('[data-act="del"]').onclick = async () => {
      await api(`api/models/providers/${id}`, { method: 'DELETE' }).catch(() => {});
      loadApiProviders();
    };
  }
}
loadApiProviders();

async function loadSpeech() {
  const box = $('speechProvider');
  if (!box) return;
  let r;
  try { r = await api('api/models/providers'); } catch { box.innerHTML = '<p class="muted">unavailable</p>'; return; }
  const sp = r.speech;
  const cur = sp ? `
    <div class="prov-row">
      <b>Speech</b>
      <span class="muted">${esc(sp.base_url)} · STT ${esc(sp.stt_model)} · TTS ${esc(sp.tts_model)}/${esc(sp.tts_voice)}${sp.key_set ? '' : ' · no key (local server)'}</span>
      <button class="btn sm ghost" id="sp-test">Test</button>
      <button class="btn sm ghost" id="sp-del">Remove</button>
      <span class="muted" id="sp-row-msg"></span>
    </div>` : '<p class="muted">Not configured — voice falls back to the browser\'s built-in speech (and STT is unavailable) until you add one or set SPARK_IP.</p>';
  box.innerHTML = cur + `
    <div class="prov-add">
      <input id="sp-base" placeholder="Base URL (e.g. https://api.openai.com, http://127.0.0.1:8880 for Kokoro-FastAPI)" value="${esc(sp?.base_url || '')}" />
      <input id="sp-key" type="password" placeholder="API key (blank for local servers)" autocomplete="off" />
      <input id="sp-stt" placeholder="STT model (whisper-1; Groq: whisper-large-v3)" value="${esc(sp?.stt_model || 'whisper-1')}" />
      <input id="sp-tts" placeholder="TTS model (tts-1; Kokoro-FastAPI: kokoro)" value="${esc(sp?.tts_model || 'tts-1')}" />
      <input id="sp-voice" placeholder="TTS voice (alloy; Kokoro: af_heart)" value="${esc(sp?.tts_voice || 'alloy')}" />
      <button class="btn sm" id="sp-save">Test & save</button>
      <span class="muted" id="sp-msg"></span>
    </div>`;
  $('sp-save').onclick = async () => {
    const msg = $('sp-msg');
    msg.textContent = 'testing tts…';
    try {
      const j = await api('api/models/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        base_url: $('sp-base').value.trim(), api_key: $('sp-key').value,
        stt_model: $('sp-stt').value.trim(), tts_model: $('sp-tts').value.trim(), tts_voice: $('sp-voice').value.trim(),
      }) });
      if (!j.ok) throw new Error(j.error || 'failed');
      msg.textContent = '✓ saved';
      loadSpeech();
    } catch (e) { msg.textContent = '⚠ ' + e.message; }
  };
  if (sp) {
    $('sp-del').onclick = async () => { await api('api/models/speech', { method: 'DELETE' }).catch(() => {}); loadSpeech(); };
    $('sp-test').onclick = async () => {
      const m = $('sp-row-msg');
      m.textContent = 'synthesizing…';
      try {
        const r2 = await fetch('api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Speech provider check.' }) });
        m.textContent = r2.ok ? `✓ audio via ${r2.headers.get('x-tts-backend') || '?'}` : '⚠ HTTP ' + r2.status;
      } catch (e) { m.textContent = '⚠ ' + e.message; }
    };
  }
}
loadSpeech();
