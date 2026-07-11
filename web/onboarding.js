// First-run onboarding wizard (design handoff): welcome → 4 steps in a left step-rail.
// Steps 1–2 are required gates (CLIs installed → signed in / provider added); 3–4 optional.
// Every step drives the REAL endpoints (tools/versions, auth start/complete, models/providers,
// models/speech, serve URL) — Settings keeps 1:1 homes for all of it afterward.
import { api, escapeHtml as esc } from './common.js';

const $ = (s) => document.querySelector(s);
const STEPS = [
  { id: 'agents', n: 1, label: 'Coding agents' },
  { id: 'signin', n: 2, label: 'Sign in' },
  { id: 'voice', n: 3, label: 'Voice', optional: true },
  { id: 'access', n: 4, label: 'Access anywhere', optional: true },
];
let phase = 'welcome'; // welcome | step id
let visited = new Set();
let tools = [];
let authStatus = { providers: [] };
let credentialed = false;

function toast(msg) {
  const t = $('#dk-toast');
  t.textContent = msg; t.hidden = false;
  setTimeout(() => (t.hidden = true), 2400);
}

async function loadState() {
  try { tools = (await api('api/tools/versions')).tools || []; } catch { tools = []; }
  try { authStatus = await api('api/auth/status'); } catch {}
  let providers = [];
  try { providers = (await api('api/models/providers')).providers || []; } catch {}
  credentialed = (authStatus.providers || []).some((p) => p.loggedIn) || providers.length > 0 || authStatus.mode === 'proxy';
}

function railHtml() {
  return STEPS.map((s) => {
    const cur = phase === s.id;
    const done = s.id === 'agents' ? tools.some((t) => t.installed) : s.id === 'signin' ? credentialed : visited.has(s.id) && !cur;
    const reachable = visited.has(s.id) || cur || credentialed || s.n <= 2;
    return `<button class="ob-step${cur ? ' cur' : ''}${done ? ' done' : ''}" data-ob-step="${s.id}" ${reachable ? '' : 'disabled'}>
      <span class="ob-step-dot">${done ? '✓' : s.n}</span>${esc(s.label)}${s.optional ? '<em>optional</em>' : ''}</button>`;
  }).join('');
}

function welcomeHtml() {
  return `
  <div class="ob-welcome" data-ob-welcome>
    <div class="dk-wordmark ob-big">Supercalm</div>
    <h1>Let's wire up this machine.</h1>
    <p>Supercalm runs and supervises coding-agent sessions on this box, and lets you triage them from anywhere. Four short steps — two required, the rest skippable. Your first project and session start in the app itself.</p>
    <div class="ob-detected" id="ob-detected">detecting…</div>
    <button class="dk-new ob-cta" data-ob-go>Get started →</button>
    <div class="ob-mins">about 2 minutes</div>
  </div>`;
}

function agentsHtml() {
  const rows = tools.map((t) => `
    <div class="ob-row">
      <i class="dk-dot ${t.installed ? 'ok' : ''}"></i>
      <b>${esc(t.id)}</b><span class="ob-ver">${esc(t.version || 'not found')}</span>
      ${t.installed ? (t.latest && t.latest !== t.version ? `<span class="dk-chip" style="color:#e2b23e;border-color:#e2b23e55">${esc(t.latest)} AVAILABLE</span><button class="dk-reply-btn" data-ob-update="${esc(t.id)}">Update</button>` : '<span class="dk-chip" style="color:#4ecb6c;border-color:#4ecb6c55">LATEST</span>') : `<button class="dk-new sm" data-ob-install="${esc(t.id)}">Install</button>`}
      <span class="ob-msg" data-msg="${esc(t.id)}"></span>
    </div>`).join('');
  return `
  <h1>Coding agents</h1>
  <p class="ob-sub">Auto-detected CLIs on this machine. Install or update what you'll use — one is enough.</p>
  <div class="ob-card">${rows || '<p class="ob-sub">scanning…</p>'}
    <button class="dk-reply-btn" data-ob-rescan>↻ Re-scan PATH</button>
  </div>
  <div class="ob-foot"><button class="dk-new" data-ob-next>Continue →</button><span class="ob-gate" data-ob-gate>${tools.some((t) => t.installed) ? '' : 'Install at least one CLI to continue'}</span></div>`;
}

function signinHtml() {
  const cards = (authStatus.providers || []).map((p) => `
    <div class="ob-card ob-auth${p.loggedIn ? ' ok' : ''}" data-provider="${esc(p.id)}">
      <div class="ob-row"><b>${esc(p.id)}</b>
        <span class="dk-chip" style="color:${p.loggedIn ? '#4ecb6c' : '#8a95a5'};border-color:currentColor">${p.loggedIn ? 'SIGNED IN' : 'NOT SIGNED IN'}</span>
        ${p.loggedIn ? `<span class="ob-ver">${esc(p.account || '')}</span>` : `<button class="dk-reply-btn" data-ob-auth="${esc(p.id)}">Sign in →</button>`}
      </div>
      <div class="ob-paste" hidden><input placeholder="Browser opened — approve there, then paste the CODE#STATE" /><button class="dk-new sm" data-ob-complete="${esc(p.id)}">Complete</button><span class="ob-msg"></span></div>
    </div>`).join('');
  return `
  <h1>Sign in</h1>
  <p class="ob-sub">Use your subscription login per CLI — or skip straight to an API key below. Either satisfies the gate.</p>
  ${cards}
  <div class="ob-or">OR — API KEY</div>
  <div class="ob-card">
    <div class="ob-grid">
      <select id="ob-kind"><option value="anthropic">Anthropic API</option><option value="openai">OpenAI-compatible</option></select>
      <input id="ob-base" placeholder="Base URL (required for OpenAI-compatible)" hidden />
      <input id="ob-key" type="password" placeholder="API key" />
      <button class="dk-new sm" data-ob-provider>Test &amp; add</button><span class="ob-msg" id="ob-prov-msg"></span>
    </div>
  </div>
  <div class="ob-foot"><button class="dk-new" data-ob-next ${credentialed ? '' : 'disabled'}>Continue →</button><span class="ob-gate" data-ob-gate>${credentialed ? '' : 'Sign in to one CLI or add one provider to continue (0 credentials yet)'}</span></div>`;
}

function voiceHtml() {
  return `
  <h1>Voice <em class="ob-opt">optional</em></h1>
  <p class="ob-sub">One OpenAI-compatible audio endpoint powers dictation and read-outs — remote (OpenAI, Groq) or local (Kokoro, whisper.cpp).</p>
  <div class="ob-card">
    <div class="ob-grid">
      <select id="ob-vpreset"><option value="">Custom…</option><option value="https://api.openai.com">OpenAI</option><option value="https://api.groq.com/openai">Groq</option><option value="http://127.0.0.1:8880">Local Kokoro</option></select>
      <input id="ob-vbase" placeholder="Base URL" />
      <input id="ob-vkey" type="password" placeholder="API key (blank for local)" />
      <button class="dk-new sm" data-ob-vtest>Test endpoint</button><span class="ob-msg" id="ob-vmsg"></span>
    </div>
    <p class="ob-fine">Test is recommended, not a gate — Continue saves untested; Skip leaves voice unconfigured. A configured Spark device keeps precedence.</p>
  </div>
  <div class="ob-foot"><button class="dk-new" data-ob-next>Continue →</button><button class="dk-reply-btn" data-ob-next>Skip</button></div>`;
}

function accessHtml() {
  return `
  <h1>Access anywhere <em class="ob-opt">optional</em></h1>
  <p class="ob-sub">With Tailscale, this dashboard (and the phone app) works from any of your devices over HTTPS.</p>
  <div class="ob-card">
    <div class="ob-row" id="ob-ts">detecting tailscaled…</div>
    <p class="ob-fine">Phone: install Tailscale → join the same tailnet → open the URL → Add to Home Screen.</p>
  </div>
  <div class="ob-foot"><button class="dk-new" data-ob-finish>Start using Supercalm →</button></div>`;
}

function render() {
  const rail = $('#ob-rail');
  if (phase === 'welcome') {
    rail.hidden = true;
    $('#ob-main').innerHTML = welcomeHtml();
    detect();
    $('[data-ob-go]').onclick = () => go('agents');
  } else {
    rail.hidden = false;
    $('#ob-rail-steps').innerHTML = railHtml();
    $('#ob-start-now').hidden = !credentialed;
    for (const b of document.querySelectorAll('[data-ob-step]')) b.onclick = () => go(b.dataset.obStep);
    $('#ob-main').innerHTML = { agents: agentsHtml, signin: signinHtml, voice: voiceHtml, access: accessHtml }[phase]();
    wire();
  }
  for (const f of document.querySelectorAll('[data-ob-finish]')) f.onclick = finish;
}

function go(step) { visited.add(phase); phase = step; render(); if (step === 'access') detectTs(); }

async function detect() {
  try {
    const h = await api('healthz');
    $('#ob-detected').innerHTML = `DETECTED — <b>${esc(location.hostname)}</b> · Supercalm v${esc(h.version)} · <span class="ok">● reachable</span> at ${esc(location.origin)}`;
  } catch { $('#ob-detected').textContent = 'server detection failed'; }
}
async function detectTs() {
  try {
    const st = await api('api/auth/status');
    $('#ob-ts').innerHTML = /ts\.net/.test(location.hostname)
      ? `<i class="dk-dot ok"></i> serving over Tailscale at <b>${esc(location.origin)}</b>`
      : `<i class="dk-dot"></i> open this box's tailnet URL to serve remotely (bin/expose sets HTTPS + /aios) · mode: ${esc(st.mode || '?')}`;
  } catch { $('#ob-ts').textContent = 'tailscale state unknown — bin/expose on the host configures it'; }
}

function wire() {
  const next = { agents: 'signin', signin: 'voice', voice: 'access' }[phase];
  for (const b of document.querySelectorAll('[data-ob-next]')) b.onclick = () => go(next);
  const rescan = document.querySelector('[data-ob-rescan]');
  if (rescan) rescan.onclick = async () => { await api('api/tools/check', { method: 'POST' }).catch(() => {}); await loadState(); render(); };
  for (const b of document.querySelectorAll('[data-ob-update],[data-ob-install]')) b.onclick = async () => {
    const id = b.dataset.obUpdate || b.dataset.obInstall;
    const m = document.querySelector(`[data-msg="${id}"]`);
    m.textContent = 'updating…';
    try { await api(`api/tools/${id}/update`, { method: 'POST' }); m.textContent = '✓'; await loadState(); render(); }
    catch (e) { m.textContent = '⚠ ' + (e.message || e); }
  };
  for (const b of document.querySelectorAll('[data-ob-auth]')) b.onclick = async () => {
    const id = b.dataset.obAuth;
    try {
      const r = await api(`api/auth/${id}/start`, { method: 'POST' });
      if (r.url) window.open(r.url, '_blank');
      const paste = document.querySelector(`[data-provider="${id}"] .ob-paste`);
      if (paste) paste.hidden = false;
    } catch (e) { toast('⚠ ' + (e.message || e)); }
  };
  for (const b of document.querySelectorAll('[data-ob-complete]')) b.onclick = async () => {
    const id = b.dataset.obComplete;
    const input = document.querySelector(`[data-provider="${id}"] .ob-paste input`);
    const m = document.querySelector(`[data-provider="${id}"] .ob-paste .ob-msg`);
    try { await api(`api/auth/${id}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: input.value.trim() }) }); m.textContent = '✓ signed in'; await loadState(); render(); }
    catch (e) { m.textContent = '⚠ ' + (e.message || e); }
  };
  const kind = $('#ob-kind');
  if (kind) kind.onchange = () => { $('#ob-base').hidden = kind.value !== 'openai'; };
  const prov = document.querySelector('[data-ob-provider]');
  if (prov) prov.onclick = async () => {
    const m = $('#ob-prov-msg');
    if ($('#ob-kind').value === 'openai' && !$('#ob-base').value.trim()) { m.textContent = '⚠ base URL is required for OpenAI-compatible providers'; return; }
    m.textContent = 'testing…';
    try {
      const r = await api('api/models/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: $('#ob-kind').value, name: $('#ob-kind').value === 'anthropic' ? 'Anthropic' : 'API', base_url: $('#ob-base').value.trim(), api_key: $('#ob-key').value }) });
      if (!r.ok) throw new Error(r.error || 'failed');
      m.textContent = '✓ added';
      await loadState(); render();
    } catch (e) { m.textContent = '⚠ ' + (e.message || e); }
  };
  const vpreset = $('#ob-vpreset');
  if (vpreset) vpreset.onchange = () => { if (vpreset.value) $('#ob-vbase').value = vpreset.value; };
  const vtest = document.querySelector('[data-ob-vtest]');
  if (vtest) vtest.onclick = async () => {
    const m = $('#ob-vmsg');
    if (!$('#ob-vbase').value.trim()) { m.textContent = '⚠ enter a base URL first'; return; }
    m.textContent = 'testing…';
    try {
      const r = await api('api/models/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ base_url: $('#ob-vbase').value.trim(), api_key: $('#ob-vkey').value }) });
      m.textContent = r.ok ? '✓ saved' : '⚠ ' + (r.error || 'failed');
    } catch (e) { m.textContent = '⚠ ' + (e.message || e); }
  };
}

async function finish() {
  await api('api/setup', { method: 'POST' }).catch(() => {});
  toast('Setup complete — this box is yours');
  setTimeout(() => (location.href = 'desktop'), 900);
}

render(); // welcome paints instantly — the CLI scan (npm registry) can take seconds
loadState().then(render);
