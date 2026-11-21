import { api, escapeHtml as esc } from './common.js';

const gib = n => Number.isFinite(n) ? `${(n / 1024 ** 3).toFixed(1)} GiB` : '—';
const phaseLabel = phase => ({ queued: 'Preparing', copying: 'Copying to local SSD', importing: 'Restoring conversation',
  activating: 'Switching execution device', complete: 'Ready · still paused', failed: 'Transfer needs attention',
  cancelled: 'Transfer stopped · originals retained' }[phase] || phase);

export function mountExecutionSettings(host) {
  const add = host.parentNode.querySelector('#st-add-device');
  host.innerHTML = `<form class="ob-card st-device-pair" id="st-device-pair" hidden aria-label="Pair an execution device">
      <h3>Pair a Mac</h3><p>Generate a setup command for the new Mac. Already have a code? Go straight to step 2.</p>
      <details><summary>What the new Mac needs</summary><p>Use a signed-in Apple Silicon Mac with Remote Login, Git, and Homebrew Node and tmux. Verify that the controller can SSH to its account using a key. No passwords go into Settings.</p></details>
      <div class="st-device-fields"><label>Device ID<input name="deviceId" placeholder="work-mac" autocapitalize="none" spellcheck="false" maxlength="40"></label>
      <label>SSH address<input name="sshHost" placeholder="user@work-mac.local" autocapitalize="none" spellcheck="false" maxlength="200"></label></div>
      <label>1. Run on the controller Mac in Terminal<textarea name="command" rows="2" readonly placeholder="Enter a device ID and SSH address to generate the command."></textarea></label>
      <div class="st-device-actions"><button class="dk-reply-btn" type="button" data-copy disabled>Copy setup command</button><small data-command-hint></small></div>
      <label>2. Enter the pairing code from Terminal<input name="code" placeholder="Device ID and one-time code" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="80"></label>
      <div class="st-device-actions"><button class="dk-new" type="submit">Connect device</button><button class="dk-reply-btn" type="button" data-cancel>Cancel</button></div>
      <p role="status"></p></form><p class="st-device-note" role="status"></p><div data-device-list>Loading devices…</div>`;
  const form = host.querySelector('form'), f = form.elements, list = host.querySelector('[data-device-list]');
  const note = host.querySelector('.st-device-note'), status = form.querySelector('[role=status]'), copy = form.querySelector('[data-copy]');
  let stopped = false, busy = false, refreshId = 0, deviceSignature;
  function toggle(show) {
    form.hidden = !show;
    add.setAttribute('aria-expanded', String(show));
    if (show) { note.textContent = ''; delete note.dataset.device; f.deviceId.focus(); }
    else { form.reset(); command(); status.textContent = ''; add.focus(); }
  }
  function command() {
    const id = f.deviceId.value.trim(), ssh = f.sshHost.value.trim();
    const validId = id !== 'local' && /^[a-z][a-z0-9_-]{0,39}$/.test(id);
    const validSsh = /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*@)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(ssh) && !/^(localhost(?:\.|$)|127\.|0\.0\.0\.0$)/i.test(ssh.split('@').at(-1));
    f.command.value = validId && validSsh ? 'cd ~/aios && bin/deploy --pair-device ' + id + ' ' + ssh : '';
    copy.disabled = !f.command.value;
    form.querySelector('[data-command-hint]').textContent = id && !validId ? 'Use a lowercase ID starting with a letter (not “local”).' : ssh && !validSsh ? 'Use a remote SSH alias or user@hostname.' : '';
  }
  add.onclick = () => { if (!busy) toggle(form.hidden); };
  f.deviceId.oninput = f.sshHost.oninput = command;
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(f.command.value); status.textContent = 'Setup command copied.'; }
    catch { f.command.focus(); f.command.select(); status.textContent = 'Command selected. Copy it to run on the controller.'; }
  };
  form.querySelector('[data-cancel]').onclick = () => { if (!busy) toggle(false); };
  form.onkeydown = e => { if (e.key === 'Escape' && !busy) { e.preventDefault(); toggle(false); } };
  form.onsubmit = async e => {
    e.preventDefault();
    if (busy) return;
    const code = f.code.value.trim();
    if (!code) { status.textContent = 'Paste the code printed by the setup command.'; f.code.focus(); return; }
    if (/^[a-z][a-z0-9_-]*\.[a-f0-9]{32}$/.test(code) && f.deviceId.value.trim() && f.deviceId.value.trim() !== code.split('.')[0]) {
      status.textContent = 'The code is for a different device ID. Check the code or the ID above.'; f.code.focus(); return;
    }
    const submit = form.querySelector('[type=submit]'), cancel = form.querySelector('[data-cancel]');
    busy = add.disabled = submit.disabled = cancel.disabled = true; status.textContent = 'Checking pairing code…';
    try {
      const result = await api('api/execution/devices/pair', { method:'POST', headers:{'content-type':'application/json','x-aios-pairing':'1'}, body:JSON.stringify({code}), signal:AbortSignal.timeout(15000) });
      window.dispatchEvent(new Event('execution-devices-changed'));
      if (!stopped) { add.disabled = false; toggle(false); note.dataset.device = result.id; note.textContent = result.label + ' added. Checking its connection…'; await refresh(); }
    } catch (e) { if (!stopped) status.textContent = e.message; }
    finally { busy = add.disabled = submit.disabled = cancel.disabled = false; }
  };
  async function refresh() {
    const ticket = ++refreshId;
    try {
      const data = await api('api/execution/devices');
      if (stopped || ticket !== refreshId || !host.isConnected) return;
      add.hidden = data.canPair === false;
      if (add.hidden) form.hidden = true;
      const signature = JSON.stringify((data.devices || []).map(d => [d.id, d.online]));
      if (deviceSignature && signature !== deviceSignature) window.dispatchEvent(new Event('execution-devices-changed'));
      deviceSignature = signature;
      const added = note.dataset.device && data.devices?.find(d => d.id === note.dataset.device);
      if (added?.online) note.textContent = added.label + ' is connected and ready for new sessions.';
      else if (added?.error) note.textContent = added.label + ' is registered but offline. Check that the Mac is awake and SSH is reachable.';
      list.innerHTML = `<div class="ob-card"><p>Code, Git, dependencies, builds and live conversations stay on the executing Mac’s SSD. Spark is for archives.</p>
        ${(data.devices || []).map(d => `<div data-execution-device="${esc(d.id)}" style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--border,#333)">
          <b>${esc(d.label)}</b><span>${d.online ? 'Connected' : !d.checked_at && !d.error ? 'Connecting…' : 'Offline · sessions preserved'}</span>
          <small style="opacity:.7">${d.local ? 'Controller · existing sessions' : `Local SSD ${gib(d.health?.disk?.available_bytes)} free · ${esc(d.health?.host?.cores || '—')} cores · v${esc(d.health?.version || '—')}${d.default ? ' · default' : ''}`}</small>
        </div>`).join('')}
        <p class="dk-hint">Choose a device in New session. For an existing paused session, open ••• → Move to device.</p></div>`;
    } catch (e) { if (!stopped && ticket === refreshId) list.textContent = 'Device list unavailable: ' + e.message; }
  }
  refresh(); const timer = setInterval(refresh, 15000);
  return () => { stopped = true; clearInterval(timer); add.onclick = null; form.reset(); };
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
      const retryable = op.phase === 'failed' || op.phase === 'activating' && op.error;
      q('[data-progress]').textContent = `${op.phase === 'complete' && op.historyOnly ? 'History and available files preserved · native conversation unavailable' : phaseLabel(op.phase)}${op.bytes ? ` · ${gib(op.bytes)} transferred` : ''}${op.error ? ` — ${op.error}` : ''}`;
      q('[data-start]').disabled = pending && !retryable || op.phase === 'complete';
      q('[data-start]').textContent = retryable ? 'Retry transfer' : 'Move';
      q('[data-device]').disabled = op.phase !== 'cancelled';
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
        const result = operation?.phase === 'failed' || operation?.phase === 'activating' && operation.error
          ? await api(`api/execution/operations/${operation.id}/retry`, { method: 'POST' })
          : await api(`api/session/${session.id}/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: q('[data-device]').value }) });
        show(result.operation);
      } catch (e) { q('[data-progress]').textContent = e.message; q('[data-start]').disabled = false; }
      finally { busy = false; }
    };
    if (operation) show(operation);
  } catch (e) { modal.querySelector('p').textContent = e.message; }
}
