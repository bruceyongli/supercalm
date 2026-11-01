import { api, escapeHtml as esc } from './common.js';

const gib = n => Number.isFinite(n) ? `${(n / 1024 ** 3).toFixed(1)} GiB` : '—';
const phaseLabel = phase => ({ queued: 'Preparing', copying: 'Copying to local SSD', importing: 'Restoring conversation',
  activating: 'Switching execution device', complete: 'Ready · still paused', failed: 'Transfer needs attention',
  cancelled: 'Transfer stopped · originals retained' }[phase] || phase);

export function mountExecutionSettings(host) {
  let stopped = false;
  async function refresh() {
    try {
      const data = await api('api/execution/devices');
      if (stopped || !host.isConnected) return;
      host.innerHTML = `<div class="ob-card"><p>Code, Git, dependencies, builds and live conversations stay on the executing Mac’s SSD. Spark is for archives.</p>
        ${(data.devices || []).map(d => `<div style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--border,#333)">
          <b>${esc(d.label)}</b><span>${d.online ? 'Connected' : 'Offline · sessions preserved'}</span>
          <small style="opacity:.7">${d.local ? 'Controller · existing sessions' : `Local SSD ${gib(d.health?.disk?.available_bytes)} free · ${esc(d.health?.host?.cores || '—')} cores · v${esc(d.health?.version || '—')}${d.default ? ' · default' : ''}`}</small>
        </div>`).join('')}
        <p class="dk-hint">Choose a device in New session. For an existing paused session, open ••• → Move to device.</p></div>`;
    } catch (e) { if (!stopped) host.textContent = e.message; }
  }
  refresh(); const timer = setInterval(refresh, 15000);
  return () => { stopped = true; clearInterval(timer); };
}

export async function openExecutionMove(session) {
  document.getElementById('execution-move')?.remove();
  const modal = document.createElement('div'); modal.id = 'execution-move'; modal.className = 'dk-palette';
  modal.innerHTML = '<div class="dk-palette-box dk-launch-box"><div class="dk-launch-h">Move paused session</div><p>Loading devices…</p></div>';
  document.body.appendChild(modal);
  let timer, busy = false;
  const close = () => { clearTimeout(timer); modal.remove(); };
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  try {
    const [devices, current] = await Promise.all([api('api/execution/devices'), api(`api/session/${session.id}/move`)]);
    if (!modal.isConnected) return;
    const choices = (devices.devices || []).filter(d => !d.local);
    modal.innerHTML = `<div class="dk-palette-box dk-launch-box"><div class="dk-launch-h">Move paused session</div>
      <p>Keep this conversation and unfinished work. The destination gets a complete local copy; the original files remain untouched.</p>
      <label class="dk-field">Execution device<select data-device>${choices.map(d => `<option value="${esc(d.id)}" ${!d.online ? 'disabled' : ''}>${esc(d.label)}${d.online ? ' · local SSD' : ' · offline'}</option>`).join('')}</select></label>
      <p data-progress role="status"></p><div class="dk-launch-foot"><button class="dk-reply-btn" data-close>Close</button><button class="dk-new" data-start ${!choices.some(d => d.online) ? 'disabled' : ''}>Move</button></div></div>`;
    const q = s => modal.querySelector(s);
    q('[data-close]').onclick = close;
    let operation = current.operation;
    const show = op => {
      operation = op;
      if (!op || !modal.isConnected) return;
      const pending = !['complete','failed','cancelled'].includes(op.phase);
      q('[data-progress]').textContent = `${phaseLabel(op.phase)}${op.bytes ? ` · ${gib(op.bytes)} transferred` : ''}${op.error ? ` — ${op.error}` : ''}`;
      q('[data-start]').disabled = pending || op.phase === 'complete' || op.phase === 'cancelled';
      q('[data-start]').textContent = op.phase === 'failed' || op.phase === 'activating' && op.error ? 'Retry transfer' : 'Move';
      q('[data-device]').disabled = true;
      if (pending) timer = setTimeout(poll, 2000);
    };
    async function poll() {
      if (!modal.isConnected) return;
      try { show((await api(`api/session/${session.id}/move`)).operation); }
      catch (e) { if (modal.isConnected) { q('[data-progress]').textContent = e.message; timer = setTimeout(poll, 5000); } }
    }
    q('[data-start]').onclick = async () => {
      if (busy) return;
      busy = true; q('[data-start]').disabled = true;
      try {
        const result = operation?.phase === 'failed'
          ? await api(`api/execution/operations/${operation.id}/retry`, { method: 'POST' })
          : await api(`api/session/${session.id}/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: q('[data-device]').value }) });
        show(result.operation);
      } catch (e) { q('[data-progress]').textContent = e.message; q('[data-start]').disabled = false; }
      finally { busy = false; }
    };
    if (operation) show(operation);
  } catch (e) { modal.querySelector('p').textContent = e.message; }
}
