import { api, escapeHtml as esc } from './common.js';

const CSS = `
.ss-intro { display:flex; align-items:flex-start; gap:12px; margin-bottom:14px; }
.ss-intro p { margin:0; flex:1; color:#8a95a5; font-size:12.5px; line-height:1.6; }
.ss-panel .dk-reply-btn { flex-shrink:0; min-height:36px; white-space:normal; }
.ss-panel button:disabled { cursor:default; opacity:.5; }
.ss-panel [hidden] { display:none !important; }
.ss-devices { display:grid; gap:10px; }
.ss-device { min-width:0; border:1px solid #232c38; border-radius:12px; background:#0d1219; padding:14px; }
.ss-device.is-default { border-color:#37577c; background:#0e1722; }
.ss-device-head { display:flex; align-items:center; flex-wrap:wrap; gap:6px 10px; }
.ss-device-head h3 { margin:0; font-size:14px; font-weight:600; color:#dde5ee; overflow-wrap:anywhere; }
.ss-badge { font-size:10.5px; line-height:1.5; color:#8a95a5; border:1px solid #293442; border-radius:5px; padding:1px 6px; }
.ss-badge.selected { color:#a8cfff; border-color:#37577c; }
.ss-state { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:#8a95a5; margin-left:auto; }
.ss-state::before { content:''; width:6px; height:6px; border-radius:50%; background:#718096; }
.ss-state.connected::before { background:#4ecb6c; }
.ss-capacity { margin:10px 0 0; font-size:12px; color:#9daaba; line-height:1.6; overflow-wrap:anywhere; }
.ss-capacity b { color:#d1dce8; font-weight:500; }
.ss-meter { width:100%; height:4px; border:0; border-radius:9px; overflow:hidden; display:block; margin:8px 0 0; appearance:none; background:#202b38; accent-color:#587ea7; }
.ss-meter::-webkit-progress-bar { background:#202b38; border-radius:9px; }
.ss-meter::-webkit-progress-value { background:#587ea7; border-radius:9px; }
.ss-meter::-moz-progress-bar { background:#587ea7; border-radius:9px; }
.ss-actions { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-top:12px; }
.ss-details { margin-top:12px; font-size:12px; color:#8a95a5; }
.ss-details summary { cursor:pointer; padding:3px 0; color:#9daaba; }
.ss-details dl { display:grid; grid-template-columns:110px minmax(0,1fr); gap:6px 12px; margin:10px 0 0; line-height:1.6; }
.ss-details dt { color:#6f7d8f; }
.ss-details dd { margin:0; overflow-wrap:anywhere; min-width:0; }
.ss-details code { font-size:11px; }
.ss-migration { margin:14px 0; padding:12px 14px; background:#101a25; border-radius:10px; }
.ss-migration-head { display:flex; gap:8px; justify-content:space-between; flex-wrap:wrap; font-size:12.5px; color:#ccd9e7; }
.ss-note { font-size:12px; line-height:1.6; color:#7f8da0; margin:9px 0 0; }
.ss-root { padding:9px 0; border-top:1px solid #23303e; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px 12px; }
.ss-root:first-child { margin-top:8px; }
.ss-root code { overflow-wrap:anywhere; line-height:1.5; }
.ss-root-state { font-size:11px; color:#9fb0c4; text-align:right; }
.ss-root-error { grid-column:1/-1; color:#e7aa83; font-size:11.5px; overflow-wrap:anywhere; }
.ss-message { margin:10px 0; color:#9fb7cf; font-size:12px; line-height:1.6; overflow-wrap:anywhere; }
.ss-message:empty { display:none; }
.ss-message.is-error { color:#e7aa83; }
.ss-add { border-top:1px solid #232c38; padding-top:14px; margin-top:16px; }
.ss-add > summary { font-size:13px; font-weight:500; color:#b7c9de; cursor:pointer; padding:3px 0; }
.ss-fields { margin:14px 0 0; padding:0; border:0; min-width:0; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
.ss-field { display:grid; gap:5px; min-width:0; font-size:12px; color:#9daaba; }
.ss-full { grid-column:1/-1; }
.ss-field input { min-width:0; max-width:100%; }
.ss-field small { color:#6f7d8f; font-size:11.5px; line-height:1.5; }
.ss-form-actions { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-top:14px; }
.ss-credential { margin:12px 0; padding:14px; border:1px solid #37577c; border-radius:10px; }
.ss-credential h3 { margin:0 0 5px; color:#ccd9e7; font-size:13px; overflow-wrap:anywhere; }
@media(max-width:480px) {
  .ss-intro { flex-wrap:wrap; }
  .ss-intro p { flex-basis:100%; }
  .ss-device { padding:12px; }
  .ss-state { margin-left:0; }
  .ss-fields { grid-template-columns:1fr; }
  .ss-field input { min-height:42px; font-size:16px; }
  .ss-panel .dk-reply-btn { min-height:40px; }
  .ss-details dl { grid-template-columns:1fr; gap:2px; }
  .ss-details dd { margin-bottom:7px; }
  .ss-root { grid-template-columns:1fr; }
  .ss-root-state { text-align:left; }
}
`;

function bytes(value) {
  if (value == null || !Number.isFinite(Number(value)) || Number(value) < 0) return 'Unknown';
  let n = Number(value), unit = 0;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit++; }
  return `${n.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function capacity(value) {
  const available = value?.available_bytes, total = value?.total_bytes;
  if (available == null) return '<p class="ss-capacity">Available space not measured yet.</p>';
  const knownTotal = Number.isFinite(Number(total)) && Number(total) > 0;
  const used = knownTotal ? Math.max(0, Math.min(100, 100 * (1 - available / total))) : null;
  return `<p class="ss-capacity"><b>${esc(bytes(available))} available</b>${knownTotal ? ` of ${esc(bytes(total))}` : ''}</p>
    ${knownTotal ? `<progress class="ss-meter" max="100" value="${used}" aria-label="Disk space used"></progress>` : ''}`;
}

function rootState(root) {
  if (root.active && root.state === 'complete') return 'On remote storage';
  return ({ planned: 'Queued', copying: 'Copying', copied: 'Ready to switch', verified: 'Ready to switch',
    'staged-changing': 'Syncing changes', verifying: 'Checking', switched: 'Finishing', reclaiming: 'Finishing',
    interrupted: 'Interrupted', failed: 'Needs attention' })[root.state] || String(root.state || 'Pending').replaceAll('-', ' ');
}

// Refresh only display nodes. The connection form is never replaced by polling.
function renderStable(target, html) {
  if (target._storageHTML === html) return;
  const open = new Set([...target.querySelectorAll('details[open][data-detail]')].map(n => n.dataset.detail));
  const focused = target.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused?.dataset.action ? `${focused.dataset.action}:${focused.dataset.device || ''}` : null;
  target.innerHTML = html;
  target._storageHTML = html;
  for (const detail of target.querySelectorAll('details[data-detail]')) detail.open = open.has(detail.dataset.detail);
  if (focusKey) [...target.querySelectorAll('[data-action]')]
    .find(n => `${n.dataset.action}:${n.dataset.device || ''}` === focusKey)?.focus({ preventScroll: true });
}

export function mountStorageSettings(host, { pollMs = 15000 } = {}) {
  if (!document.getElementById('settings-storage-css')) {
    const style = document.createElement('style'); style.id = 'settings-storage-css'; style.textContent = CSS;
    document.head.appendChild(style);
  }
  host.classList.add('ss-panel');
  host.innerHTML = `<div class="ss-intro"><p>Choose where new work is saved. Local storage is the default; another device can hold files while agents and databases stay on this host.</p>
    <button class="dk-reply-btn" type="button" data-storage-refresh>Refresh</button></div>
    <div class="ss-devices" data-storage-devices aria-busy="true"><p class="ss-note">Loading storage…</p></div>
    <form class="ss-credential" data-storage-credential hidden autocomplete="off" aria-labelledby="ss-credential-title">
      <h3 id="ss-credential-title" data-storage-credential-title>Update saved password</h3>
      <p class="ss-note" data-storage-credential-account></p>
      <fieldset class="ss-fields" data-storage-credential-fields><label class="ss-field ss-full">New file-sharing password
        <input class="st-inp" name="password" type="password" autocomplete="new-password" maxlength="4096" required></label></fieldset>
      <div class="ss-form-actions"><button class="dk-reply-btn" type="submit" data-storage-credential-save>Save &amp; reconnect</button>
        <button class="dk-reply-btn" type="button" data-storage-credential-cancel>Cancel</button></div>
      <p class="ss-note">Updates macOS Keychain only. Existing files and your storage default stay unchanged.</p>
    </form>
    <div data-storage-migration></div>
    <p class="ss-note" data-storage-scope>Existing files stay in their current location. Changing the default does not migrate or delete them.</p>
    <p class="ss-message" data-storage-message role="status" aria-live="polite"></p>
    <p class="ss-message is-error" data-storage-error role="alert"></p>
    <details class="ss-add" data-storage-add><summary>Add storage device</summary>
      <p class="ss-note">Connect an SMB share on another computer or NAS. A grow-as-needed APFS volume preserves project file permissions.</p>
      <form data-storage-form autocomplete="off"><fieldset class="ss-fields" data-storage-fields>
        <label class="ss-field">Device name<input class="st-inp" name="label" placeholder="Spark" maxlength="80" required></label>
        <label class="ss-field">Share URL<input class="st-inp" name="url" placeholder="smb://192.168.1.20/storage" type="text" inputmode="url" spellcheck="false" autocapitalize="none" required></label>
        <label class="ss-field">File-sharing username<input class="st-inp" name="account" maxlength="120" spellcheck="false" autocapitalize="none" required></label>
        <label class="ss-field">File-sharing password<input class="st-inp" name="password" type="password" autocomplete="new-password" maxlength="4096" required></label>
        <label class="ss-field ss-full">Maximum volume size (GiB)<input class="st-inp" name="sizeGiB" type="number" min="32" max="16384" step="1" value="1024" required><small>A size limit, not space reserved now. 1024 GiB = 1 TiB.</small></label>
      </fieldset>
      <p class="ss-note">The password is saved in this host’s macOS Keychain, not in browser storage. The device reconnects automatically after login.</p>
      <div class="ss-form-actions"><button class="dk-reply-btn" type="submit" data-storage-save>Save &amp; connect</button><span class="ss-note">Does not change your default.</span></div>
      </form></details>
    <p class="ss-note" data-storage-unsupported hidden>Automatic remote-storage setup currently requires a macOS host. Local storage remains available.</p>`;

  const find = selector => host.querySelector(selector);
  const devices = find('[data-storage-devices]'), migration = find('[data-storage-migration]');
  const form = find('[data-storage-form]'), fields = find('[data-storage-fields]');
  const refreshButton = find('[data-storage-refresh]'), saveButton = find('[data-storage-save]');
  const message = find('[data-storage-message]'), error = find('[data-storage-error]');
  const credentialForm = find('[data-storage-credential]'), credentialFields = find('[data-storage-credential-fields]');
  const credentialSave = find('[data-storage-credential-save]'), credentialCancel = find('[data-storage-credential-cancel]');
  let credentialDevice = null;
  let snapshot = null, disposed = false, writing = false, timer = null, readController = null, writeController = null;
  let readSequence = 0;
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

  function buttons() {
    refreshButton.disabled = writing || !!readController;
    fields.disabled = writing || snapshot?.setupSupported === false;
    credentialFields.disabled = writing || snapshot?.setupSupported === false;
    credentialSave.disabled = writing || !snapshot || snapshot.setupSupported === false;
    credentialCancel.disabled = writing;
    saveButton.disabled = writing || !snapshot || snapshot.setupSupported === false;
    for (const button of devices.querySelectorAll('[data-action]')) {
      const device = snapshot?.devices?.find(d => d.id === button.dataset.device);
      button.disabled = writing || !snapshot || (button.dataset.action !== 'select' && snapshot.setupSupported === false) || (button.dataset.action === 'select'
        && (snapshot.migration?.running || snapshot.defaultDevice === button.dataset.device
          || (button.dataset.device !== 'local' && !device?.available)));
    }
  }

  function render(value) {
    snapshot = value;
    const selected = id => value.defaultDevice === id;
    const badge = id => selected(id) ? '<span class="ss-badge selected">Default for new files</span>' : '';
    const select = id => `<button class="dk-reply-btn" type="button" data-action="select" data-device="${esc(id)}">${selected(id) ? 'Selected' : 'Use for new files'}</button>`;
    renderStable(devices, `<article class="ss-device${selected('local') ? ' is-default' : ''}" data-storage-device="local">
      <div class="ss-device-head"><h3>Local host</h3>${badge('local')}<span class="ss-badge">Factory default</span></div>
      ${capacity(value.local)}<div class="ss-actions">${select('local')}</div></article>
      ${(value.devices || []).map(device => `<article class="ss-device${selected(device.id) ? ' is-default' : ''}" data-storage-device="${esc(device.id)}">
        <div class="ss-device-head"><h3>${esc(device.label || device.id)}</h3>${badge(device.id)}
          ${device.current && !selected(device.id) ? '<span class="ss-badge">Existing file location</span>' : ''}
          <span class="ss-state${device.available ? ' connected' : ''}">${device.available ? 'Connected' : 'Not connected'}</span></div>
        ${capacity(device.status?.volume)}
        ${device.status?.backing?.available_bytes != null ? `<p class="ss-note">${esc(bytes(device.status.backing.available_bytes))} available on the device’s physical disk.</p>` : ''}
        ${device.status?.error ? `<p class="ss-message is-error">${esc(device.status.error)}</p>` : ''}
        <div class="ss-actions">${select(device.id)}<button class="dk-reply-btn" type="button" data-action="connect" data-device="${esc(device.id)}">${device.available ? 'Check connection' : 'Connect'}</button></div>
        <details class="ss-details" data-detail="${esc(device.id)}"><summary>Connection &amp; paths</summary><dl>
          <dt>SMB share</dt><dd><code>${esc(device.url)}</code></dd><dt>Account</dt><dd>${esc(device.account)}</dd>
          <dt>Credentials</dt><dd>${esc(device.credentials || 'macOS Keychain')}</dd>
          <dt>Mounted volume</dt><dd><code>${esc(device.mount)}</code></dd>
          <dt>Disk image</dt><dd><code>${esc(device.image)}</code></dd>
          ${device.sizeGiB ? `<dt>Maximum size</dt><dd>${esc(device.sizeGiB)} GiB</dd>` : ''}</dl>
          <div class="ss-actions"><button class="dk-reply-btn" type="button" data-action="credentials" data-device="${esc(device.id)}">Update saved password</button></div>
        </details></article>`).join('')}`);
    devices.setAttribute('aria-busy', 'false');
    const progress = value.migration;
    renderStable(migration, progress?.running ? `<div class="ss-migration">
      <div class="ss-migration-head"><b>Moving existing files</b><span>${esc(progress.completed)} / ${esc(progress.total)} roots ready</span></div>
      <progress class="ss-meter" max="${Math.max(1, Number(progress.total) || 1)}" value="${Math.max(0, Number(progress.completed) || 0)}" aria-label="Storage roots migrated"></progress>
      <p class="ss-note">The destination is locked until migration and session recovery finish. Root counts do not indicate time remaining.</p>
      <details class="ss-details" data-detail="migration-roots"><summary>View storage roots</summary>
        ${(progress.roots || []).map(root => `<div class="ss-root"><code>${esc(root.source)}</code><span class="ss-root-state">${esc(rootState(root))}</span>
          ${root.error ? `<div class="ss-root-error">${esc(root.error)}</div>` : ''}</div>`).join('')}</details></div>` : '');
    find('[data-storage-add]').hidden = value.setupSupported === false;
    find('[data-storage-unsupported]').hidden = value.setupSupported !== false;
    buttons();
  }

  function schedule() {
    clearTimeout(timer); timer = null;
    if (!disposed && !document.hidden && !writing && !readController) timer = setTimeout(refresh, pollMs);
  }
  async function refresh() {
    if (disposed || document.hidden || writing || readController) return;
    clearTimeout(timer);
    const controller = new AbortController(), sequence = ++readSequence;
    readController = controller; buttons();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const result = await api('api/settings/storage', { signal: controller.signal });
      if (!disposed && sequence === readSequence && !writing) { render(result); setText(error, ''); }
    } catch (e) {
      if (!disposed && sequence === readSequence && !document.hidden) {
        setText(error, `Could not refresh storage. ${e.name === 'AbortError' ? 'The connection timed out.' : String(e.message || e)}${snapshot ? ' Showing the last known status.' : ' Try Refresh.'}`);
        if (!snapshot) {
          renderStable(devices, '<p class="ss-note">Storage status is unavailable.</p>');
          devices.setAttribute('aria-busy', 'false');
        }
      }
    } finally {
      clearTimeout(timeout);
      if (readController === controller) readController = null;
      if (!disposed) { buttons(); schedule(); }
    }
  }

  async function change(action, pending) {
    if (disposed || writing) return;
    writing = true; clearTimeout(timer); readSequence++;
    readController?.abort(); readController = null;
    const controller = new AbortController(); writeController = controller;
    setText(error, ''); setText(message, pending); buttons();
    const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal });
    // Initial share/image setup can take minutes. Do not treat it as a 20-second read.
    const timeout = setTimeout(() => controller.abort(), 8 * 60 * 1000);
    try { await action(post); }
    catch (e) {
      if (!disposed) {
        setText(message, '');
        setText(error, e.name === 'AbortError' ? 'The connection was interrupted. Setup may still be finishing on the host. Refresh its status before retrying.' : String(e.message || e));
      }
    } finally {
      clearTimeout(timeout); writeController = null; writing = false;
      if (!disposed) { buttons(); schedule(); }
    }
  }

  async function saveSecret(post, path, input) {
    try { return await post(path, input); }
    catch (e) {
      const detail = String(e.message || e);
      if (input.password && detail.includes(input.password)) throw Object.assign(
        new Error(detail.split(input.password).join('[redacted]')), { name: e.name || 'Error' });
      throw e; // AbortError's message can be read-only, especially in WebKit.
    }
    finally { input.password = ''; }
  }
  function closeCredentials() {
    credentialForm.hidden = true; credentialForm.elements.password.value = ''; credentialDevice = null;
  }

  const onClick = event => {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const id = button.dataset.device, device = snapshot?.devices?.find(d => d.id === id);
    if (button.dataset.action === 'credentials') {
      credentialDevice = id; credentialForm.elements.password.value = ''; credentialForm.hidden = false;
      setText(find('[data-storage-credential-title]'), `Update password for ${device?.label || 'storage'}`);
      setText(find('[data-storage-credential-account]'), `File-sharing account: ${device?.account || ''}`);
      credentialForm.scrollIntoView({ block: 'nearest' }); credentialForm.elements.password.focus({ preventScroll: true });
    } else if (button.dataset.action === 'connect') change(async post => {
      const result = await post(`api/settings/storage/devices/${encodeURIComponent(id)}/connect`);
      if (!disposed) { render(result); setText(message, 'Connection checked. The default has not changed.'); }
    }, `Connecting to ${device?.label || 'storage'}… This can take a few minutes.`);
    else if (button.dataset.action === 'select') change(async post => {
      const result = await post('api/settings/storage/default', { device: id });
      if (!disposed) { render(result); setText(message, 'Default saved for new files. Existing files have not been moved.'); }
    }, 'Saving storage default…');
  };
  const onSubmit = event => {
    event.preventDefault();
    if (writing || !snapshot || snapshot.setupSupported === false || !form.reportValidity()) return;
    const input = Object.fromEntries(new FormData(form)); input.sizeGiB = Number(input.sizeGiB);
    // The form remains mounted for drafts, but secrets leave it as soon as submitted.
    form.elements.password.value = '';
    change(async post => {
      const saved = await saveSecret(post, 'api/settings/storage/devices', input);
      if (disposed) return;
      render(saved); setText(message, 'Device saved. Connecting… This can take a few minutes.');
      try {
        const result = await post(`api/settings/storage/devices/${encodeURIComponent(saved.id)}/connect`);
        if (!disposed) { render(result); setText(message, 'Device connected. Choose “Use for new files” when ready. Existing files stay where they are.'); form.reset(); find('[data-storage-add]').open = false; }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw new Error(`Device saved, but connection did not finish. ${e.message || e} Use its Connect button to retry, or update its saved password; no need to add it again.`);
      }
    }, 'Saving device securely…');
  };
  const onCredentialSubmit = event => {
    event.preventDefault();
    if (writing || !credentialDevice || !snapshot || snapshot.setupSupported === false || !credentialForm.reportValidity()) return;
    const id = credentialDevice, input = { password: credentialForm.elements.password.value };
    credentialForm.elements.password.value = '';
    change(async post => {
      const saved = await saveSecret(post, `api/settings/storage/devices/${encodeURIComponent(id)}/credentials`, input);
      if (disposed) return;
      render(saved); closeCredentials(); setText(message, 'Password saved. Reconnecting…');
      try {
        const result = await post(`api/settings/storage/devices/${encodeURIComponent(id)}/connect`);
        if (!disposed) { render(result); setText(message, 'Password updated and connection checked. Existing files and the default are unchanged.'); }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw new Error(`Password saved, but connection did not finish. ${e.message || e} Use Connect to retry.`);
      }
    }, 'Updating the saved password…');
  };
  const onVisibility = () => {
    if (document.hidden) { clearTimeout(timer); readController?.abort(); }
    else refresh();
  };
  refreshButton.addEventListener('click', refresh);
  devices.addEventListener('click', onClick);
  form.addEventListener('submit', onSubmit);
  credentialForm.addEventListener('submit', onCredentialSubmit);
  credentialCancel.addEventListener('click', closeCredentials);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', refresh);
  refresh();
  return () => {
    disposed = true; clearTimeout(timer); readSequence++;
    readController?.abort(); writeController?.abort(); form.elements.password.value = ''; closeCredentials();
    refreshButton.removeEventListener('click', refresh); devices.removeEventListener('click', onClick);
    form.removeEventListener('submit', onSubmit); credentialForm.removeEventListener('submit', onCredentialSubmit);
    credentialCancel.removeEventListener('click', closeCredentials); document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', refresh);
  };
}
