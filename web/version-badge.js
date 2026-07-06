// New-version toast (bottom-right). The single source of truth for the release version is the
// server's package.json, surfaced at GET /api/version (see src/config.js VERSION). This module records
// the version present when the page loaded, then re-checks (poll + on focus/visibility/online); when a
// deploy bumps the server to a newer version it shows a small clickable toast — with the new version
// number — nudging a reload. Nothing is shown until a new version actually appears.
//
// It ALSO surfaces UPSTREAM releases: the server checks GitHub every ~12h (src/update_check.js,
// GET /api/update) and when a newer release exists than this server is running, the toast links to the
// release page and names the update command (`bin/update`). The local reload toast wins when both apply
// (reloading is step one); an upstream nudge is dismissible per-version (remembered in localStorage).
//
// Self-contained: loaded via <script type="module" src="version-badge.js"> on EVERY top-level page
// (including session.html — on a page with a full-width footer composer the toast sits just above it).
// Add the tag to any new page. The /api/version body is ~20 bytes (no DB, sent uncompressed), so the
// poll is far lighter than the dashboard's existing 15s /api/state poll — friendly to DERP links.

(() => {
  if (window.__aiosVersionToast) return; // idempotent: never mount twice
  window.__aiosVersionToast = true;

  const POLL_MS = 30_000;
  const UPDATE_POLL_MS = 30 * 60_000; // upstream releases move slowly; the server caches its own check anyway
  const DISMISS_KEY = 'aios_update_dismissed';
  let baseline = null; // version observed when this page loaded
  let shown = null; // toast content key currently displayed (avoid rebuilding on every poll)
  let upstream = null; // {version, url} when GitHub has a newer release than this server

  async function getJson(path) {
    try {
      const r = await fetch(path, { cache: 'no-store' });
      return r.ok ? await r.json() : null;
    } catch {
      return null; // server mid-restart / offline — try again next tick, never throw
    }
  }

  function toastEl() {
    let el = document.getElementById('aios-version-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'aios-version-toast';
      el.className = 'version-toast';
      el.setAttribute('role', 'status');
      (document.body || document.documentElement).appendChild(el);
    }
    // Stay clear of a full-width footer composer (the session page): sit just above it. Other pages
    // keep the CSS default (bottom-right). Recomputed each time it's shown.
    const composer = document.querySelector('.footer-composer');
    el.style.bottom = composer && composer.offsetParent !== null
      ? `${Math.max(14, Math.round(window.innerHeight - composer.getBoundingClientRect().top + 12))}px`
      : '';
    return el;
  }

  // Local: this server moved to a newer build than the page — reload to pick it up.
  function showReloadToast(version) {
    shown = 'reload:' + version;
    const el = toastEl();
    el.title = 'Reload to load the new version';
    el.onclick = () => location.reload();
    el.innerHTML =
      `<span class="vt-up">↑</span>` +
      `<span class="vt-text"><span class="vt-line">New version <b>v${version}</b></span>` +
      `<span class="vt-sub">Reload to update</span></span>` +
      `<span class="vt-icon">⟳</span>`;
    requestAnimationFrame(() => el.classList.add('in'));
  }

  // Upstream: GitHub has a newer release than this server — link the release, name the update command.
  function showUpstreamToast(u) {
    shown = 'upstream:' + u.version;
    const el = toastEl();
    el.title = 'Open the release on GitHub — update with bin/update';
    el.onclick = (e) => {
      if (e.target?.dataset?.dismiss) {
        try { localStorage.setItem(DISMISS_KEY, u.version); } catch {}
        el.classList.remove('in');
        shown = null;
        return;
      }
      window.open(u.url, '_blank', 'noopener');
    };
    el.innerHTML =
      `<span class="vt-up">⇡</span>` +
      `<span class="vt-text"><span class="vt-line">Update available <b>v${u.version}</b></span>` +
      `<span class="vt-sub">View on GitHub · run bin/update</span></span>` +
      `<span class="vt-x" data-dismiss="1" title="Dismiss this version">×</span>`;
    requestAnimationFrame(() => el.classList.add('in'));
  }

  async function check() {
    const v = await getJson('api/version');
    const version = v?.version || null;
    if (!version) return;
    if (baseline == null) baseline = version; // first read = the running build
    if (version !== baseline) {
      if (shown !== 'reload:' + version) showReloadToast(version); // local reload always wins
      return;
    }
    if (upstream && shown == null) {
      let dismissed = null;
      try { dismissed = localStorage.getItem(DISMISS_KEY); } catch {}
      if (dismissed !== upstream.version) showUpstreamToast(upstream);
    }
  }

  async function checkUpstream() {
    const r = await getJson('api/update');
    upstream = r?.update && r.update.version && r.update.url ? { version: r.update.version, url: r.update.url } : null;
    check();
  }

  check();
  checkUpstream();
  setInterval(check, POLL_MS);
  setInterval(checkUpstream, UPDATE_POLL_MS);
  // Snappy detection when the user returns to / refocuses the tab or the network comes back.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  addEventListener('focus', check);
  addEventListener('online', check);
})();
