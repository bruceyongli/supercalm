import { api, escapeHtml as esc } from './common.js';

const gib = n => Number.isFinite(n) ? `${(n / 1024 ** 3).toFixed(1)} GiB` : '—';
const phaseLabel = phase => ({ queued: 'Preparing', copying: 'Copying to local SSD', importing: 'Restoring conversation',
  activating: 'Switching execution device', complete: 'Ready · still paused', failed: 'Transfer needs attention',
  cancelled: 'Transfer stopped · originals retained' }[phase] || phase);

export function mountExecutionSettings(host) {
  const add = host.parentNode.querySelector('#st-add-device');
  host.innerHTML = `<form class="ob-card st-device-pair" id="st-device-pair" hidden aria-label="Pair an execution device">
      <h3>Connect an execution device</h3><p>Enter its SSH address. The controller checks the device, installs the worker, and connects it.</p>
      <div class="st-device-fields"><label>SSH address<input name="sshHost" placeholder="user@work-mac.local" autocapitalize="none" spellcheck="false" maxlength="200"></label>
      <label>Device ID<input name="deviceId" placeholder="work-mac" autocapitalize="none" spellcheck="false" maxlength="40"></label></div>
      <div class="st-device-actions"><button class="dk-new" type="submit">Connect device</button><button class="dk-reply-btn" type="button" data-cancel>Close</button></div>
      <p role="status"></p><a href="#st-storage" data-storage-link hidden>Open storage settings</a>
      <details><summary>Device requirements</summary><p>Use a signed-in Apple Silicon Mac with Remote Login, Git, Homebrew Node and tmux. The controller must already trust the host and have key-based SSH access. No passwords or keys go into Settings.</p></details>
      <details data-manual><summary>Already have a pairing code?</summary><label>Pairing code<input name="code" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="80"></label>
      <button class="dk-reply-btn" type="button" data-claim>Use pairing code</button></details></form>
      <p class="st-device-note" role="status"></p><div data-device-list>Loading devices…</div>`;
  const form=host.querySelector('form'), f=form.elements, list=host.querySelector('[data-device-list]');
  const note=host.querySelector('.st-device-note'), status=form.querySelector('[role=status]'), storageLink=form.querySelector('[data-storage-link]');
  const submit=form.querySelector('[type=submit]'), claim=form.querySelector('[data-claim]'), receiptKey='aios-device-setup-job';
  const headers={'content-type':'application/json','x-aios-pairing':'1'};
  let stopped=false,busy=false,refreshId=0,deviceSignature,pollTimer,job='',idEdited=false;
  const say=text=>{status.textContent=text;note.textContent=form.hidden?text:'';};
  function remember(value){job=value;try{if(value)sessionStorage.setItem(receiptKey,value);else sessionStorage.removeItem(receiptKey);}catch{}}
  function setBusy(value){busy=value;for(const el of [submit,claim,f.code,f.deviceId,f.sshHost])el.disabled=value;add.textContent=value?'View setup':'Add device';}
  function toggle(show){
    form.hidden=!show;add.setAttribute('aria-expanded',String(show));
    if(show){note.textContent='';delete note.dataset.device;if(!busy)f.sshHost.focus();}
    else{if(busy)note.textContent=status.textContent;else{form.reset();form.querySelector('[data-manual]').open=false;status.textContent='';storageLink.hidden=true;idEdited=false;}add.focus();}
  }
  function added(id){
    remember('');setBusy(false);if(!form.hidden)toggle(false);
    note.dataset.device=id;note.textContent=id+' added. Checking its connection…';
    window.dispatchEvent(new Event('execution-devices-changed'));void refresh();
  }
  function fail(message,code){
    remember('');setBusy(false);say(message);storageLink.hidden=code!=='linux-host';
  }
  function follow(state){
    if(stopped)return;
    if(state.stage==='failed'){fail(state.error,state.code);return;}
    if(state.stage==='added'){added(state.id);return;}
    remember(state.job);setBusy(true);
    say(({checking:'Checking SSH and device requirements…',installing:'Installing and verifying the worker…',registering:'Registering the verified device…'})[state.stage]||'Checking setup…');
    pollTimer=setTimeout(poll,1000);
  }
  async function poll(){
    if(stopped || !job)return;
    try{follow(await api('api/execution/devices/setup/'+job,{signal:AbortSignal.timeout(10000)}));}
    catch(e){if(stopped)return;if(e.status===404){fail(e.message);void refresh();}else{say('Reconnecting to setup status…');pollTimer=setTimeout(poll,2500);}}
  }
  f.deviceId.oninput=()=>{idEdited=!!f.deviceId.value;};
  f.sshHost.oninput=()=>{
    if(idEdited)return;
    let id=f.sshHost.value.trim().split('@').at(-1).split('.')[0].toLowerCase().replace(/[^a-z0-9_-]/g,'');
    if(id && (!/^[a-z]/.test(id)||id==='local'))id='device-'+id;
    f.deviceId.value=id.slice(0,40);
  };
  add.onclick=()=>toggle(form.hidden);form.querySelector('[data-cancel]').onclick=()=>toggle(false);
  form.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();toggle(false);}else if(e.key==='Enter'&&e.target===f.code){e.preventDefault();claim.click();}};
  form.onsubmit=async e=>{
    e.preventDefault();if(busy)return;
    const id=f.deviceId.value.trim(),host=f.sshHost.value.trim();
    if(!/^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*@)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host)||/^(localhost(?:\.|$)|127\.|0\.0\.0\.0$)/i.test(host.split('@').at(-1))){say('Enter a remote SSH alias or user@hostname.');f.sshHost.focus();return;}
    if(id==='local'||!/^[a-z][a-z0-9_-]{0,39}$/.test(id)){say('Use a lowercase device ID starting with a letter (not “local”).');f.deviceId.focus();return;}
    setBusy(true);storageLink.hidden=true;say('Starting device setup…');
    try{follow(await api('api/execution/devices/setup',{method:'POST',headers,body:JSON.stringify({id,host}),signal:AbortSignal.timeout(15000)}));}
    catch(e){if(!stopped)fail(e.message);}
  };
  claim.onclick=async()=>{
    if(busy)return;const code=f.code.value.trim();
    if(!code){say('Enter your existing pairing code.');f.code.focus();return;}
    if(/^[a-z][a-z0-9_-]*\.[a-f0-9]{32}$/.test(code) && f.deviceId.value.trim() && f.deviceId.value.trim()!==code.split('.')[0]){
      say('This code is for a different device ID. Check the code or the ID above.');return;
    }
    setBusy(true);storageLink.hidden=true;say('Checking pairing code…');
    try{const result=await api('api/execution/devices/pair',{method:'POST',headers,body:JSON.stringify({code}),signal:AbortSignal.timeout(15000)});if(!stopped)added(result.id);}
    catch(e){if(!stopped)fail(e.message,e.code);}
  };
  try{const saved=sessionStorage.getItem(receiptKey);if(/^[a-f0-9]{40}$/.test(saved||'')){job=saved;setBusy(true);void poll();}}catch{}
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
  return () => { stopped=true;clearInterval(timer);clearTimeout(pollTimer);add.onclick=null;form.reset(); };
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
