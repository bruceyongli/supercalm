// Agent Builder panel — describe an agent in natural language; the backend generates it (syntax-checked)
// into data/agents/<id>/ DISABLED with no granted capabilities. The operator then reviews + grants caps in
// the Agents tab. Editing an existing drop-in agent reuses the same flow with editId.

let P = null;
let host = null;
let spec = '';
let model = '';
let busy = false;
let lastResult = null;
let agentsList = [];
const esc = (s) => P.escapeHtml(s);

export const panel = {
  mount(el, papi) {
    P = papi;
    host = el;
    model = papi.view()?.config?.model || papi.view()?.data?.defaultModel || '';
    render();
    refreshList();
  },
  update() {
    if (!busy) render();
  },
};

function view() {
  return P.view() || {};
}
function hasManage() {
  return (view().grant?.caps || []).includes('manage-agents');
}

async function refreshList() {
  try {
    const r = await P.call('models', {});
    agentsList = r.result?.agents || [];
    if (!model) model = r.result?.models?.[0]?.id || '';
    render();
  } catch {}
}

function render() {
  if (!host) return;
  const models = view().data?.models || [];
  const opts = models.map((m) => `<option value="${esc(m.id)}" ${m.id === model ? 'selected' : ''}>${esc(m.label || m.id)}</option>`).join('') || `<option value="${esc(model)}">${esc(model || '(default)')}</option>`;
  const manageWarn = !hasManage()
    ? '<div class="sup-hint sup-warn">The Builder needs the <b>manage-agents</b> capability to write agents. Enable Builder and grant it in the <b>Agents</b> tab first.</div>'
    : '';
  host.innerHTML = `
    <section class="su-card">
      <h2><span>Agent Builder</span></h2>
      <p class="agent-desc muted">Describe an agent. It will be generated <b>disabled</b> with no permissions — review the code, then enable &amp; grant capabilities in the Agents tab.</p>
      ${manageWarn}
      <label class="sup-field compact">Model
        <select id="bld-model">${opts}</select>
      </label>
      <textarea id="bld-spec" class="sup-doc-edit" rows="6" placeholder="e.g. A view agent that shows the session's open TODO comments from the git diff. Or: an agent that, on each stop review, posts a one-line summary of what changed to the terminal.">${esc(spec)}</textarea>
      <div class="sup-actions">
        <button class="btn" id="bld-create" ${busy ? 'disabled' : ''}>${busy ? 'Building…' : 'Build agent'}</button>
      </div>
      ${lastResult ? resultCard(lastResult) : ''}
    </section>
    ${agentsList.length ? listCard(agentsList) : ''}`;
  wire();
}

function resultCard(r) {
  return `<div class="su-card sup-verdict-card">
    <div class="sup-section-h">Built: ${esc(r.name || r.id)} <span class="agent-kind">${esc(r.kind || 'agent')}</span></div>
    <p class="sup-assess">${esc(r.note || '')}</p>
    <p class="agent-desc muted">Files: ${(r.written || []).map(esc).join(', ')} · Declared caps: ${(r.capabilities || []).map(esc).join(', ') || 'none'}</p>
  </div>`;
}

function listCard(list) {
  return `<details class="su-card sup-history" open><summary>Drop-in agents (${list.length})</summary>${list
    .map(
      (a) => `<div class="sup-hist-row"><b>${esc(a.name)}</b><span class="agent-kind">${esc(a.kind)}</span><span class="agent-desc muted">${esc(a.description || '')}</span><button class="btn ghost sm" data-edit="${esc(a.id)}">Edit</button></div>`
    )
    .join('')}</details>`;
}

function wire() {
  const on = (sel, ev, fn) => {
    const el = host.querySelector(sel);
    if (el) el[ev] = fn;
  };
  on('#bld-model', 'onchange', (e) => {
    model = e.target.value;
    P.save({ config: { model } }).catch(() => {});
  });
  on('#bld-spec', 'oninput', (e) => {
    spec = e.target.value;
    P.markDirty();
  });
  on('#bld-create', 'onclick', () => build());
  host.querySelectorAll('[data-edit]').forEach((el) => (el.onclick = () => editAgent(el.dataset.edit)));
}

async function build(editId) {
  if (!spec.trim()) {
    alert('Describe the agent first.');
    return;
  }
  busy = true;
  render();
  try {
    const r = await P.call('create', { spec, model, editId });
    lastResult = r.result;
    P.clearDirty();
    await P.api('api/agents/reload', { method: 'POST' }).catch(() => {});
    await refreshList();
  } catch (e) {
    const msg = e.message || String(e);
    alert(/manage-agents/.test(msg) ? 'Grant the Builder the "manage-agents" capability in the Agents tab first.' : 'Build failed: ' + msg);
  } finally {
    busy = false;
    render();
  }
}

function editAgent(id) {
  const a = agentsList.find((x) => x.id === id);
  if (!a) return;
  spec = `Edit the "${a.name}" agent: `;
  render();
  host.querySelector('#bld-spec')?.focus();
  // operator finishes the instruction, then Build with editId
  const btn = host.querySelector('#bld-create');
  if (btn) btn.onclick = () => build(id);
}
