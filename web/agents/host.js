import { $, api, escapeHtml, isInteracting } from '../common.js';

// Frontend agent host: builds the side-panel tab bar from the agent registry, owns tab state + the
// shared dirty/edit-lock, mounts panel modules (supervisor, builder, drop-ins), and renders the
// Agents-home (recommender + capability-consent UI). Map/Usage stay as "legacy" bridges — their
// endpoints are unchanged, so the host just toggles their existing DOM and calls their loader.

const HIGH_RISK = new Set(['send-input', 'write-files', 'exec', 'manage-agents']);
const CAP_LABEL = {
  'read-context': 'Read session context (git diff, terminal, messages)',
  screenshot: 'Capture preview screenshots',
  'model-calls': 'Call LLM models (metered to Usage)',
  'send-input': 'Send input INTO the running CLI agent',
  'write-files': 'Write files in the project directory',
  exec: 'Run shell commands',
  'manage-agents': 'Create / edit other agents',
};
const PREF = 'aios_side_tab';
// gear/settings icon for the Agents button (manage + create agents) — distinct from the tab buttons.
const GEAR_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
// Builder is the "create an agent" surface — reached from the Agents page, never a tab.
const NON_TAB = new Set(['builder']);

export function initAgentPanel({ sessionId, tabsEl, panelsEl, legacy = {}, onTabChange = () => {}, dock = false }) {
  let agents = [];
  const sideTabParam = (() => { try { return new URLSearchParams(location.search).get('sideTab') || ''; } catch { return ''; } })();
  let active = sideTabParam || localStorage.getItem(PREF) || 'map';
  let homeEl = null;
  const modules = new Map(); // id -> { el, inst, papi, dirty }
  const base = document.baseURI;
  // Agent dock (session view only, `dock:true`): a 44px rail is always visible; ONE drawer opens on
  // demand, defaulting CLOSED so the log surface is full-width. Non-dock callers (the phone panels
  // sheet) keep the classic always-open tab strip — `open` stays true so tabs highlight + refresh()
  // renders the Agents home. `shellEl`/`scrimEl` are null off the session view; every use is guarded.
  let open = !dock;
  const shellEl = panelsEl.closest('.session-shell');
  const scrimEl = $('#agent-dock-scrim');
  const dockAc = new AbortController();

  const view = (id) => agents.find((a) => a.id === id);
  const tabbable = () => agents.filter((a) => a.active && !NON_TAB.has(a.id)).sort((a, b) => (a.ui?.order ?? 100) - (b.ui?.order ?? 100));
  // 'agents' (home) and 'builder' (create-agent) are valid views without being tabs.
  const isView = (id) => id === 'agents' || id === 'builder' || tabbable().some((a) => a.id === id);

  async function load() {
    const r = await api(`api/session/${sessionId}/agents`).catch(() => null);
    if (r?.agents) agents = r.agents;
    renderTabs();
    if (!isView(active)) active = tabbable()[0]?.id || 'agents';
    if (dock) markActiveTab(); // dock defaults CLOSED — pick a default target but do NOT open a drawer
    else await activate(active); // classic tab strip (phone): reveal the active panel on load
  }

  // ---- tabs ----------------------------------------------------------------
  function renderTabs() {
    const tabs = tabbable();
    if (dock) {
      // Agent dock: a 44px rail — one glyph per active agent (+ attention dot) with the gear pinned for
      // the Agents manager. A glyph click toggles ITS drawer (see onGlyphClick).
      tabsEl.innerHTML =
        `<div class="rail-mini-col dock-glyphs">${tabs.map(glyphBtn).join('')}</div>` +
        `<button class="side-agents-btn dock-gear" data-tab="agents" title="Agents — activate, permissions & create" aria-label="Agents">${GEAR_SVG}</button>`;
      tabsEl.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => onGlyphClick(b.dataset.tab)));
    } else {
      // Classic tab strip (phone panels sheet): a tab per agent + the gear; a tab click reveals its panel.
      tabsEl.innerHTML =
        `<div class="side-tabs-grid">${tabs.map((a) => tabBtn(a.id, a.ui?.tab || a.name, dotFor(a))).join('')}</div>` +
        `<button class="side-agents-btn" data-tab="agents" title="Agents — activate, permissions & create" aria-label="Agents">${GEAR_SVG}</button>`;
      tabsEl.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => activate(b.dataset.tab)));
    }
    markActiveTab();
  }
  function tabBtn(id, label, dot = '', title = '') {
    return `<button class="side-tab-btn" data-tab="${escapeHtml(id)}" role="tab" title="${escapeHtml(title || label)}">${escapeHtml(label)}${dot}</button>`;
  }
  function glyphBtn(a) {
    const label = a.ui?.tab || a.name;
    const glyph = escapeHtml(String(a.ui?.glyph || label).trim().charAt(0).toUpperCase()); // first letter (icon field is future-proof)
    return `<button class="mini-btn dock-glyph" data-tab="${escapeHtml(a.id)}" role="tab" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${glyph}${dotFor(a)}</button>`;
  }
  // Rail glyph click: toggle THIS agent's drawer (click the already-open one to close). Gear = manager.
  function onGlyphClick(id) {
    const current = id === 'agents' ? active === 'agents' || active === 'builder' : active === id;
    if (open && current) close();
    else openDrawer(id);
  }
  async function openDrawer(id) {
    open = true;
    shellEl?.classList.add('dock-open');
    if (scrimEl) scrimEl.hidden = false; // CSS reveals the scrim only ≤1194px (overlay); desktop pushes
    await activate(id);
    markActiveTab();
  }
  function close() {
    if (!open || !dock) return;
    open = false;
    shellEl?.classList.remove('dock-open');
    if (scrimEl) scrimEl.hidden = true;
    markActiveTab();
    onTabChange(); // syncSize: the log reclaims full width
  }
  function dotFor(a) {
    const v = a.data?.latest?.verdict;
    if (a.grant?.enabled && (v === 'off_track' || v === 'needs_attention')) return `<span class="side-tab-dot sup-dot-${v}"></span>`;
    return '';
  }
  function markActiveTab() {
    tabsEl.querySelectorAll('[data-tab]').forEach((b) => {
      // the gear lights up for both the Agents home and the Builder (both live "inside" Agents).
      const sel = b.classList.contains('side-agents-btn') ? active === 'agents' || active === 'builder' : b.dataset.tab === active;
      const on = open && sel; // in the dock, a glyph is lit only while its drawer is open
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  // ---- panel activation ----------------------------------------------------
  function hideAll() {
    panelsEl.querySelectorAll('.side-tab-panel').forEach((p) => (p.hidden = true));
    if (homeEl) homeEl.hidden = true;
  }
  async function activate(id) {
    active = id;
    localStorage.setItem(PREF, id);
    hideAll();
    markActiveTab();
    if (id === 'agents') {
      renderHome();
    } else if (legacy[id]) {
      const sec = $(`#s-${id}`);
      if (sec) sec.hidden = false;
      try {
        await legacy[id].load();
      } catch {}
    } else {
      await mountModule(id);
    }
    onTabChange();
  }

  async function mountModule(id) {
    const a = view(id);
    if (!a) return;
    let m = modules.get(id);
    if (!m) {
      const el = document.createElement('section');
      el.className = 'side-tab-panel';
      el.id = `s-agent-${id}`;
      el.hidden = true; // stay hidden through the async import; revealed below only if still active
      panelsEl.appendChild(el);
      m = { el, inst: null, papi: null, dirty: false };
      modules.set(id, m);
      try {
        const url = a.source === 'dropin' ? new URL(`api/agents/${id}/panel.js`, base).href : new URL(`agents/${id}.js`, base).href;
        const mod = await import(url);
        m.inst = mod.panel || mod.default || mod;
        m.papi = makePapi(id, m);
        await m.inst.mount?.(el, m.papi);
      } catch (e) {
        el.innerHTML = `<section class="su-card"><span class="muted">Failed to load ${escapeHtml(id)} panel: ${escapeHtml(e.message || String(e))}</span></section>`;
      }
    }
    // Only reveal if this tab is STILL active — a fast tab switch during the await above must not
    // un-hide a now-inactive panel (that produced two stacked panels, e.g. Builder under Map).
    if (active !== id) return;
    hideAll(); // exclusivity: drop the Agents home / any sibling a mistimed refresh left visible
    m.el.hidden = false;
    try {
      m.inst?.update?.(view(id));
    } catch {}
  }

  function makePapi(id, m) {
    const post = (path, body) =>
      api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => {
        if (r?.agents) {
          agents = r.agents;
          renderTabs();
        }
        return r;
      });
    return {
      sessionId,
      api,
      $,
      escapeHtml,
      view: () => view(id),
      markDirty: () => {
        m.dirty = true;
      },
      clearDirty: () => {
        m.dirty = false;
      },
      isDirty: () => m.dirty,
      call: (action, body) => post(`api/session/${sessionId}/agents/${id}/${action}`, body),
      save: (patch) =>
        post(`api/session/${sessionId}/agents/${id}`, patch).then((r) => {
          m.dirty = false;
          return r;
        }),
    };
  }

  // ---- refresh (on SSE 'changed') ------------------------------------------
  function refresh() {
    api(`api/session/${sessionId}/agents`)
      .then((r) => {
        if (!r?.agents) return;
        agents = r.agents;
        renderTabs();
        const m = modules.get(active);
        // Skip re-rendering the open panel while the user is interacting with it (focused field, open
        // <details>, selection) — not just when "dirty". This is what stopped the settings drawer from
        // collapsing on its own. Tabs/dots above already re-rendered.
        if (m && !m.el.hidden && !m.dirty && !isInteracting(m.el)) {
          try {
            m.inst?.update?.(view(active));
          } catch {}
        }
        if (open && active === 'agents') renderHome(); // never render Home into a closed drawer
      })
      .catch(() => {});
  }

  // ---- Agents-home: recommender + enable + capability consent ---------------
  function renderHome() {
    if (!homeEl) {
      homeEl = document.createElement('section');
      homeEl.className = 'side-tab-panel agents-home';
      homeEl.id = 's-agents-home';
      panelsEl.appendChild(homeEl);
    }
    // Exclusivity: renderHome() is also called from refresh() (not just activate()), so hide every other
    // panel here too — otherwise a mistimed refresh stacks the Agents home ON TOP of a revealed panel
    // (the "two stacked panels" bug, e.g. the Council panel showing under the agents list).
    panelsEl.querySelectorAll('.side-tab-panel').forEach((p) => { if (p !== homeEl) p.hidden = true; });
    homeEl.hidden = false;
    // Builder isn't listed as a normal agent — it's the "Create agent" action below.
    const sorted = [...agents].filter((a) => !NON_TAB.has(a.id)).sort((a, b) => (b.recommend || 0) - (a.recommend || 0) || (a.ui?.order ?? 100) - (b.ui?.order ?? 100));
    homeEl.innerHTML =
      `<div class="agents-home-head"><h2>Agents</h2><div class="agents-home-actions"><button class="btn sm" id="agents-create" title="Build a new custom agent">+ Create agent</button><button class="btn ghost sm" id="agents-reload" title="Re-scan drop-in agents">Reload</button></div></div>` +
      `<p class="agents-home-hint muted">Activate agents for this session. <strong>High-risk capabilities</strong> (sending input, writing files, running code) are off by default — grant them explicitly.</p>` +
      sorted.map(agentCard).join('');
    homeEl.querySelector('#agents-reload').onclick = async () => {
      await api('api/agents/reload', { method: 'POST' }).catch(() => {});
      await load();
      renderHome();
    };
    homeEl.querySelector('#agents-create').onclick = () => activate('builder');
    homeEl.querySelectorAll('[data-enable]').forEach((el) => (el.onchange = () => setEnabled(el.dataset.enable, el.checked)));
    homeEl.querySelectorAll('[data-cap]').forEach((el) => (el.onchange = () => setCap(el.dataset.agent, el.dataset.cap, el.checked)));
    homeEl.querySelectorAll('[data-open]').forEach((el) => (el.onclick = () => activate(el.dataset.open)));
  }

  function agentCard(a) {
    const granted = new Set(a.grant?.caps || []);
    const caps = (a.capabilities || [])
      .map((c) => {
        const hi = HIGH_RISK.has(c);
        const on = granted.has(c);
        return `<label class="cap ${hi ? 'cap-hi' : ''}"><input type="checkbox" data-agent="${escapeHtml(a.id)}" data-cap="${escapeHtml(c)}" ${on ? 'checked' : ''} ${hi ? '' : 'disabled'}/> <span>${escapeHtml(CAP_LABEL[c] || c)}</span>${hi ? ' <em class="cap-risk">high-risk</em>' : ''}</label>`;
      })
      .join('');
    const rec = (a.recommend || 0) >= 0.7 ? '<span class="agent-rec">Suggested</span>' : '';
    return `<div class="agent-card kind-${escapeHtml(a.kind)}">
      <div class="agent-card-head">
        <label class="sup-switch"><input type="checkbox" data-enable="${escapeHtml(a.id)}" ${a.active ? 'checked' : ''}/> <b>${escapeHtml(a.name)}</b></label>
        ${rec}<span class="agent-kind">${escapeHtml(a.kind)}</span>
        <button class="btn ghost sm" data-open="${escapeHtml(a.id)}">Open</button>
      </div>
      <p class="agent-desc muted">${escapeHtml(a.description || '')}</p>
      ${a.capabilities?.length ? `<details class="agent-caps"><summary>Capabilities (${granted.size}/${a.capabilities.length} granted)</summary>${caps}</details>` : ''}
    </div>`;
  }

  async function setEnabled(id, enabled) {
    try {
      await api(`api/session/${sessionId}/agents/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
    } catch (e) {
      alert('Failed: ' + e.message);
    }
    await load();
    renderHome();
  }
  async function setCap(id, cap, on) {
    const a = view(id);
    const caps = new Set(a?.grant?.caps || (a?.capabilities || []).filter((c) => !HIGH_RISK.has(c)));
    on ? caps.add(cap) : caps.delete(cap);
    try {
      await api(`api/session/${sessionId}/agents/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ caps: [...caps] }) });
    } catch (e) {
      alert('Failed: ' + e.message);
    }
    await load();
    renderHome();
  }

  // Full teardown: unmount every mounted panel module and remove its DOM. Each module's unmount() clears
  // what it created — notably the Map panel's unmount() destroys its graph, which clears web/agents/graph.js's
  // ~80ms node-animation interval (the documented residual leak). Knowledge/Preflight null their host refs;
  // any without unmount() are simply removed. Called by the session's destroySession() and by the in-place
  // session switch before re-mounting for the next session.
  function destroy() {
    try { dockAc.abort(); } catch {} // remove esc + scrim listeners
    try { shellEl?.classList.remove('dock-open'); } catch {}
    try { if (scrimEl) scrimEl.hidden = true; } catch {}
    open = !dock;
    for (const [, m] of modules) {
      try { m.inst?.unmount?.(); } catch {}
      try { m.el?.remove(); } catch {}
    }
    modules.clear();
    try { homeEl?.remove(); } catch {}
    homeEl = null;
  }

  if (dock) {
    // esc closes the topmost drawer; a scrim tap (compact overlay) closes it. Both scoped to dock mode.
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); close(); } }, { signal: dockAc.signal });
    scrimEl?.addEventListener('click', () => close(), { signal: dockAc.signal });
  }

  load();
  return { refresh, activate, reload: load, destroy, open: openDrawer, close, isOpen: () => open };
}
