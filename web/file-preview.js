import { escapeHtml, renderMarkdown } from './common.js';

// Shared by clicked report/terminal links and the Files/Preview workspaces.
export function mountFilePreview(host, meta, { signal, isCurrent = () => true, fullscreen } = {}) {
  const stopMedia = () => host.querySelectorAll('audio, video').forEach(media => media.pause());
  stopMedia();
  signal?.addEventListener('abort', stopMedia, { once: true });
  const textFile = !meta.binary && (Boolean(meta.renderUrl) || !['image', 'video', 'audio', 'pdf'].includes(meta.contentKind));
  const markdown = textFile && /\.(md|markdown)$/i.test(meta.path);
  const rendered = textFile && (meta.renderUrl ? meta.renderInline !== false : markdown);
  let mode = rendered ? 'rendered' : 'source', revision = 0, textPromise;
  const current = () => !signal?.aborted && isCurrent() && host.isConnected;
  const loadText = () => textPromise ||= fetch(meta.viewUrl, { signal }).then(r => {
    if (!r.ok) throw new Error(`Could not load source (HTTP ${r.status})`);
    return r.text();
  }).catch(error => { textPromise = null; throw error; });
  const openUrl = meta.renderUrl || meta.viewUrl;
  host.innerHTML = `<div class="file-toolbar">
    ${rendered ? '<button class="btn ghost sm" data-file-mode="rendered" type="button">Rendered</button><button class="btn ghost sm" data-file-mode="source" type="button">Source</button>' : ''}
    ${textFile ? '<button class="btn ghost sm" data-file-copy type="button">Copy source</button>' : ''}
    ${fullscreen ? '<button class="btn ghost sm" data-file-full type="button">⛶ Fullscreen</button>' : ''}
    <a class="btn ghost sm" data-file-open href="${escapeHtml(openUrl)}" target="_blank" rel="noopener noreferrer">${meta.renderUrl ? 'Open rendered' : 'Open tab'} ↗</a>
    <a class="btn ghost sm" href="${escapeHtml(meta.downloadUrl)}" download>Download</a>
    <span class="count" data-file-message></span>
  </div><div class="asset-detail-body" data-file-body></div>`;
  const body = host.querySelector('[data-file-body]');
  const message = host.querySelector('[data-file-message]');
  async function paint() {
    const rev = ++revision;
    for (const button of host.querySelectorAll('[data-file-mode]')) {
      const on = button.dataset.fileMode === mode;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }
    if (mode === 'rendered' && meta.renderUrl) {
      body.innerHTML = `<iframe class="file-render-frame" title="Rendered ${escapeHtml(meta.name || meta.path)}" sandbox="allow-scripts allow-popups" referrerpolicy="no-referrer" src="${escapeHtml(meta.renderUrl)}"></iframe>`;
      return;
    }
    if (meta.contentKind === 'image') { body.innerHTML = `<img class="asset-detail-image" src="${escapeHtml(meta.viewUrl)}" alt="${escapeHtml(meta.path)}">`; return; }
    if (meta.contentKind === 'video') { body.innerHTML = `<video class="asset-detail-video" controls playsinline preload="metadata" src="${escapeHtml(meta.viewUrl)}"></video>`; return; }
    if (meta.contentKind === 'audio') { body.innerHTML = `<audio class="asset-detail-audio" controls preload="metadata" aria-label="${escapeHtml(meta.name || meta.path)}" src="${escapeHtml(meta.viewUrl)}"></audio>`; return; }
    if (!textFile) { body.innerHTML = `<div class="asset-detail-file"><a href="${escapeHtml(openUrl)}" target="_blank" rel="noopener noreferrer">${meta.contentKind === 'pdf' ? 'Open PDF ↗' : 'Download file'}</a></div>`; return; }
    body.innerHTML = '<div class="workspace-empty">Loading source…</div>';
    try {
      const text = await loadText();
      if (!current() || rev !== revision) return;
      const note = meta.truncated ? '\n\n… Source truncated at 2 MB — download for the full file.' : '';
      body.innerHTML = mode === 'rendered' ? `<div class="md-view">${renderMarkdown(text)}</div>`
        : `<pre class="asset-detail-text">${escapeHtml(text + note)}</pre>`;
    } catch (error) {
      if (current() && rev === revision) body.innerHTML = `<div class="workspace-empty">${escapeHtml(error.message)}</div>`;
    }
  }
  host.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || !current()) return;
    if (button.dataset.fileMode) { mode = button.dataset.fileMode; void paint(); }
    else if (button.hasAttribute('data-file-full')) fullscreen?.();
    else if (button.hasAttribute('data-file-copy')) {
      try { const text = await loadText(); if (!current()) return; await navigator.clipboard.writeText(text); message.textContent = 'Copied'; }
      catch { if (current()) message.textContent = 'Copy failed — select source manually'; }
    }
  }, { signal });
  return paint();
}
