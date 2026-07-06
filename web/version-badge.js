// New-version toast (bottom-right). The single source of truth for the release version is the
// server's package.json, surfaced at GET /api/version (see src/config.js VERSION). This module records
// the version present when the page loaded, then re-checks (poll + on focus/visibility/online); when a
// deploy bumps the server to a newer version it shows a small clickable toast — with the new version
// number — nudging a reload. Nothing is shown until a new version actually appears.
//
// Self-contained: loaded via <script type="module" src="version-badge.js"> on EVERY top-level page
// (including session.html — on a page with a full-width footer composer the toast sits just above it).
// Add the tag to any new page. The /api/version body is ~20 bytes (no DB, sent uncompressed), so the
// poll is far lighter than the dashboard's existing 15s /api/state poll — friendly to DERP links.

(() => {
  if (window.__aiosVersionToast) return; // idempotent: never mount twice
  window.__aiosVersionToast = true;

  const POLL_MS = 30_000;
  let baseline = null; // version observed when this page loaded
  let shown = null; // version currently displayed in the toast (avoid rebuilding on every poll)

  async function fetchVersion() {
    try {
      const r = await fetch('api/version', { cache: 'no-store' });
      if (!r.ok) return null;
      const { version } = await r.json();
      return version || null;
    } catch {
      return null; // server mid-restart / offline — try again next tick, never throw
    }
  }

  function showToast(version) {
    shown = version;
    let el = document.getElementById('aios-version-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'aios-version-toast';
      el.className = 'version-toast';
      el.setAttribute('role', 'status');
      el.title = 'Reload to load the new version';
      el.onclick = () => location.reload();
      (document.body || document.documentElement).appendChild(el);
    }
    el.innerHTML =
      `<span class="vt-up">↑</span>` +
      `<span class="vt-text"><span class="vt-line">New version <b>v${version}</b></span>` +
      `<span class="vt-sub">Reload to update</span></span>` +
      `<span class="vt-icon">⟳</span>`;
    // Stay clear of a full-width footer composer (the session page): sit just above it. Other pages
    // keep the CSS default (bottom-right). Recomputed each time it's shown.
    const composer = document.querySelector('.footer-composer');
    el.style.bottom = composer && composer.offsetParent !== null
      ? `${Math.max(14, Math.round(window.innerHeight - composer.getBoundingClientRect().top + 12))}px`
      : '';
    requestAnimationFrame(() => el.classList.add('in'));
  }

  async function check() {
    const version = await fetchVersion();
    if (!version) return;
    if (baseline == null) { baseline = version; return; } // first read = the running build
    if (version !== baseline && version !== shown) showToast(version);
  }

  check();
  setInterval(check, POLL_MS);
  // Snappy detection when the user returns to / refocuses the tab or the network comes back.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  addEventListener('focus', check);
  addEventListener('online', check);
})();
