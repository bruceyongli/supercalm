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

  // Release-channel filter: "stable only" (default) users skip the reload toast for routine every-release
  // auto-deploys and only get it for a blessed STABLE release; "every release" gets every bump (the old
  // behavior). Stored in localStorage by Settings → Preferences (aios_stable_only), default ON.
  function stableOnly() {
    try { const v = localStorage.getItem('aios_stable_only'); return v == null ? true : v === '1'; } catch { return true; }
  }

  // Local: this server moved to a newer build than the page — reload to pick it up.
  function showReloadToast(version, isStable) {
    shown = 'reload:' + version;
    const el = toastEl();
    el.title = 'Reload to load the new version';
    el.onclick = () => location.reload();
    el.innerHTML =
      `<span class="vt-up">↑</span>` +
      `<span class="vt-text"><span class="vt-line">New ${isStable ? 'stable ' : ''}version <b>v${version}</b></span>` +
      `<span class="vt-sub">Reload to update</span></span>` +
      `<span class="vt-icon">⟳</span>`;
    requestAnimationFrame(() => el.classList.add('in'));
  }

  // Upstream: GitHub has a newer release than this server. When the server says it can self-update
  // (clean git clone), the toast IS the update button: click → POST /api/update/apply → the server
  // pulls + restarts itself → the fast /api/version poll sees the new build → the reload toast takes
  // over. Otherwise it links the release and names the manual command.
  function showUpstreamToast(u) {
    shown = 'upstream:' + u.version;
    const el = toastEl();
    el.title = u.canApply ? 'Update this server now (pull + restart)' : 'Open the release on GitHub — update with bin/update';
    el.onclick = async (e) => {
      if (e.target?.dataset?.dismiss) {
        try { localStorage.setItem(DISMISS_KEY, u.version); } catch {}
        el.classList.remove('in');
        shown = null;
        return;
      }
      if (e.target?.dataset?.gh) { window.open(u.url, '_blank', 'noopener'); return; }
      if (!u.canApply) { window.open(u.url, '_blank', 'noopener'); return; }
      try {
        const r = await fetch('api/update/apply', { method: 'POST' });
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || 'HTTP ' + r.status);
        showApplyingToast(u);
      } catch (err) {
        el.querySelector('.vt-sub').textContent = 'could not start: ' + (err.message || err);
      }
    };
    el.innerHTML =
      `<span class="vt-up">⇡</span>` +
      `<span class="vt-text"><span class="vt-line">Update available <b>v${u.version}</b></span>` +
      `<span class="vt-sub">${u.canApply ? 'Click to update now' : 'run bin/update'} · <span data-gh="1" class="vt-gh">GitHub ↗</span></span></span>` +
      `<span class="vt-x" data-dismiss="1" title="Dismiss this version">×</span>`;
    requestAnimationFrame(() => el.classList.add('in'));
  }

  // Updating in progress: the server is pulling + restarting. Poll /api/update for a failure verdict;
  // success needs no handling here — the version poll notices the new build and shows the reload toast.
  function showApplyingToast(u) {
    shown = 'applying:' + u.version;
    const el = toastEl();
    el.title = 'Updating — the server restarts itself; you will be offered a reload';
    el.onclick = null;
    el.innerHTML =
      `<span class="vt-up">⇡</span>` +
      `<span class="vt-text"><span class="vt-line">Updating to <b>v${u.version}</b>…</span>` +
      `<span class="vt-sub">pull · install · restart — hold on</span></span>` +
      `<span class="vt-icon">⟳</span>`;
    requestAnimationFrame(() => el.classList.add('in'));
    const t0 = Date.now();
    const watch = setInterval(async () => {
      if (shown !== 'applying:' + u.version) { clearInterval(watch); return; }
      const r = await getJson('api/update');
      if (r?.lastRun && !r.lastRun.ok && r.lastRun.at > t0 - 5000) {
        clearInterval(watch);
        shown = null;
        upstream = { ...u, canApply: false };
        showUpstreamToast(upstream);
        toastEl().querySelector('.vt-sub').textContent = 'update failed — see data/update.log';
      }
      if (Date.now() - t0 > 4 * 60_000) clearInterval(watch); // give up watching; version poll still runs
    }, 5000);
  }

  async function check() {
    const v = await getJson('api/version');
    const version = v?.version || null;
    if (!version) return;
    if (baseline == null) baseline = version; // first read = the running build
    if (version !== baseline) {
      // Skip the toast for a routine every-release bump when the user is on "stable only" — they stay put
      // until a blessed stable release lands (channel === 'stable'). "every release" users always see it.
      const gated = stableOnly() && v?.channel && v.channel !== 'stable';
      if (!gated && shown !== 'reload:' + version) showReloadToast(version, v?.channel === 'stable'); // local reload wins
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
    upstream = r?.update && r.update.version && r.update.url
      ? { version: r.update.version, url: r.update.url, canApply: !!r.canApply }
      : null;
    if (r?.applying && upstream) { showApplyingToast(upstream); return; }
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
