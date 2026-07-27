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
// Self-contained: loaded by the single desktop SPA shell and every intentional standalone page.
// Add the tag to any new standalone surface. The /api/version body is ~20 bytes (no DB, sent uncompressed), so the
// poll is far lighter than the dashboard's existing 15s /api/state poll — friendly to DERP links.

(() => {
  if (window.__aiosVersionToast) return; // idempotent: never mount twice
  window.__aiosVersionToast = true;

  const POLL_MS = 30_000;
  const UPDATE_POLL_MS = 30 * 60_000; // upstream releases move slowly; the server caches its own check anyway
  const DISMISS_KEY = 'aios_update_dismissed';
  const UPGRADE_NOTICE_KEY = 'aios_upgrade_notified_version';
  const UPGRADE_NOTICE_MS = 8_000;
  const RELOAD_PARAM = '_aios_reload';
  let baseline = null; // version observed when this page loaded
  let serverVersion = null; // latest version returned by the server
  let shown = null; // toast content key currently displayed (avoid rebuilding on every poll)
  let upstream = null; // {version, url} when GitHub has a newer release than this server
  let autoDismissTimer = null;
  let publishedVersion = null;

  // A cache-busting query is used only for the hard navigation. Remove it as soon as the fresh page
  // starts so copied session/story links remain clean; all original route/query state is preserved.
  try {
    const clean = new URL(location.href);
    if (clean.searchParams.has(RELOAD_PARAM)) {
      clean.searchParams.delete(RELOAD_PARAM);
      history.replaceState(history.state, '', clean.pathname + clean.search + clean.hash);
    }
  } catch {}

  async function getJson(path) {
    try {
      const r = await fetch(path, { cache: 'no-store' });
      return r.ok ? await r.json() : null;
    } catch {
      return null; // server mid-restart / offline — try again next tick, never throw
    }
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function publishVersion(version) {
    if (!version) return;
    for (const el of document.querySelectorAll('[data-aios-version]')) el.textContent = `v${version}`;
    if (publishedVersion === version) return;
    publishedVersion = version;
    dispatchEvent(new CustomEvent('aios:version', { detail: { version } }));
  }

  function updateControlEl() {
    let wrap = document.getElementById('aios-update-control');
    if (wrap) return wrap;
    wrap = document.createElement('div');
    wrap.id = 'aios-update-control';
    wrap.className = 'app-update-control';
    wrap.hidden = true;
    wrap.innerHTML = `
      <button class="auc-scrim" type="button" data-update-close aria-label="Close app update"></button>
      <section class="auc-sheet" role="dialog" aria-modal="true" aria-labelledby="auc-title">
        <div class="auc-head">
          <div><span class="auc-kicker">SUPERCalm PWA</span><h2 id="auc-title">App update</h2></div>
          <button class="auc-close" type="button" data-update-close aria-label="Close">×</button>
        </div>
        <div class="auc-versions" aria-live="polite">
          <span>Opened</span><b data-update-current>—</b>
          <span>Latest</span><b data-update-latest>checking…</b>
        </div>
        <p class="auc-status" data-update-status>Checking for the latest release…</p>
        <div class="auc-actions">
          <button class="auc-primary" type="button" data-update-reload>Reload latest</button>
          <button class="auc-secondary" type="button" data-update-check>Check again</button>
        </div>
      </section>`;
    (document.body || document.documentElement).appendChild(wrap);
    return wrap;
  }

  function closeUpdateControl() {
    const wrap = document.getElementById('aios-update-control');
    if (!wrap || wrap.hidden) return;
    wrap.hidden = true;
    document.body?.classList.remove('app-update-open');
  }

  async function updateServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return;
      await registration.update();
      const waiting = registration.waiting;
      if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
    } catch {
      // A service worker is optional here: app code is served no-store, so the hard navigation below
      // remains the authoritative refresh path even when iOS declines a worker update.
    }
  }

  async function inspectLatest() {
    const wrap = updateControlEl();
    const status = wrap.querySelector('[data-update-status]');
    const latest = wrap.querySelector('[data-update-latest]');
    status.textContent = 'Checking for the latest release…';
    latest.textContent = 'checking…';
    wrap.querySelector('[data-update-check]').disabled = true;
    await updateServiceWorker();
    const v = await getJson(`api/version?manual=${Date.now()}`);
    wrap.querySelector('[data-update-check]').disabled = false;
    if (!v?.version) {
      latest.textContent = 'unavailable';
      status.textContent = 'Could not reach the server. You can still reload and try again.';
      return null;
    }
    serverVersion = v.version;
    publishVersion(serverVersion);
    latest.textContent = `v${serverVersion}`;
    status.textContent = baseline && serverVersion !== baseline
      ? `v${serverVersion} is ready. Reload to use it.`
      : `You’re on the latest release, v${serverVersion}.`;
    return v;
  }

  function openUpdateControl() {
    dismissToast();
    const wrap = updateControlEl();
    wrap.querySelector('[data-update-current]').textContent = baseline ? `v${baseline}` : 'this app';
    wrap.querySelector('[data-update-latest]').textContent = serverVersion ? `v${serverVersion}` : 'checking…';
    wrap.hidden = false;
    document.body?.classList.add('app-update-open');
    wrap.querySelector('[data-update-reload]')?.focus({ preventScroll: true });
    inspectLatest();
  }

  async function reloadLatest() {
    const wrap = updateControlEl();
    const button = wrap.querySelector('[data-update-reload]');
    const status = wrap.querySelector('[data-update-status]');
    button.disabled = true;
    button.textContent = 'Loading…';
    status.textContent = 'Loading the latest app…';
    await updateServiceWorker();
    const next = new URL(location.href);
    next.searchParams.set(RELOAD_PARAM, String(Date.now()));
    location.replace(next.href);
  }

  function positionToast(el) {
    if (!el?.isConnected) return;
    // PHONES: leave placement entirely to the CSS media rules (session pages: top-right banner; other
    // pages: above the drawer-nav zone). An inline bottom here beats the media query's `bottom: auto`
    // and stretched the toast into a full-height column (top + bottom both pinned — judge-blocking).
    if (matchMedia('(max-width: 600px)').matches) { el.style.bottom = ''; return; }
    // Desktop: stay clear of a full-width footer composer (the session page): sit just above it. Other
    // pages keep the CSS default (bottom-right). This is repeated after mount because the session
    // composer may finish rendering just after this module's first network response.
    const composer = document.querySelector('.footer-composer');
    const composerRect = composer?.getBoundingClientRect();
    const composerVisible = composerRect && composerRect.width > 0 && composerRect.height > 0;
    el.style.bottom = composerVisible
      ? `${Math.max(14, Math.round(window.innerHeight - composerRect.top + 12))}px`
      : '';
  }

  function toastEl() {
    let el = document.getElementById('aios-version-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'aios-version-toast';
      el.className = 'version-toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-hidden', 'true');
      (document.body || document.documentElement).appendChild(el);
    }
    el.inert = false;
    el.setAttribute('aria-hidden', 'false');
    positionToast(el);
    requestAnimationFrame(() => positionToast(el));
    setTimeout(() => positionToast(el), 250);
    return el;
  }

  function dismissToast(expected = shown) {
    if (expected && shown !== expected) return;
    clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
    const el = document.getElementById('aios-version-toast');
    if (el) {
      // Removing opacity is not enough: an invisible fixed element still participates in hit-testing.
      // Disable every interaction path synchronously, then remove the node entirely so composer clicks
      // can never be intercepted by a stale Settings/reload handler.
      el.onclick = null;
      el.classList.remove('in');
      el.setAttribute('aria-hidden', 'true');
      el.inert = true;
      el.remove();
    }
    shown = null;
  }

  function revealToast(el, { autoDismiss = 0 } = {}) {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
    // Phones have no dead corner — every toast auto-hides after a beat there (the raising condition
    // re-fires on the next poll/page if still relevant); desktop keeps per-variant behavior.
    if (!autoDismiss && matchMedia('(max-width: 600px)').matches) autoDismiss = 12_000;
    const contentKey = shown;
    requestAnimationFrame(() => {
      if (!el.isConnected || shown !== contentKey) return;
      positionToast(el);
      el.classList.add('in');
      if (autoDismiss > 0) {
        autoDismissTimer = setTimeout(() => dismissToast(contentKey), autoDismiss);
      }
    });
  }

  // Release-notification mode (Settings → Preferences, aios_release_notify): 'stable' (default) toasts only
  // for a blessed stable release; 'every' toasts every deploy (old behavior); 'off' silences the release
  // system entirely (no reload nudge, no upstream nudge).
  function releaseNotify() {
    try { return localStorage.getItem('aios_release_notify') || 'stable'; } catch { return 'stable'; }
  }

  // Post-upgrade orientation (first-time-user report: upgraders "got lost after seeing so many UI
  // changes … and errors in settings"). The reload toast covers the moment OF the deploy; this covers
  // the visit AFTER it: this browser last saw version X, the server now runs Y → one dismissible toast
  // pointing at Settings (the 1:1 homes for every setup step), so changed/broken config has an obvious
  // front door. Remembered per browser in localStorage; shown once per version jump.
  const SEEN_KEY = 'aios_seen_version';
  function checkUpgraded(version, channel) {
    let seen = null;
    let notified = null;
    try { seen = localStorage.getItem(SEEN_KEY); } catch {}
    try { notified = localStorage.getItem(UPGRADE_NOTICE_KEY); } catch {}
    try { localStorage.setItem(SEEN_KEY, version); } catch {}
    const mode = releaseNotify();
    const routineRelease = mode === 'stable' && channel && channel !== 'stable';
    if (!seen || seen === version || notified === version || mode === 'off' || routineRelease || shown) return;
    // Record before painting so simultaneous tabs and reloads cannot each mount the same notice.
    try { localStorage.setItem(UPGRADE_NOTICE_KEY, version); } catch {}
    shown = 'upgraded:' + version;
    const el = toastEl();
    el.title = 'Review Settings — every setup step has a home there';
    el.onclick = (e) => {
      if (e.target?.closest?.('a')) return; // the "what's new ↗" link opens itself (new tab), no Settings nav
      if (e.target?.dataset?.dismiss) {
        e.preventDefault();
        e.stopPropagation();
        dismissToast('upgraded:' + version);
        return;
      }
      location.href = 'settings';
    };
    el.innerHTML =
      `<span class="vt-up">✦</span>` +
      `<span class="vt-text"><span class="vt-line">Updated <b>v${seen}</b> → <b>v${version}</b></span>` +
      `<span class="vt-sub" data-changes>What’s new — loading…</span></span>` +
      `<span class="vt-x" data-dismiss="1" title="Dismiss">×</span>`;
    // Keep the toast present while its release comments load. Starting the short dismissal window here
    // used to make a slow /api/changes response arrive after the toast was already gone.
    revealToast(el);
    // Fill in WHAT changed — cleaned commit subjects between the two versions + a details link to the GitHub
    // compare page. Fail-soft: on error/empty, keep the generic "review Settings" hint.
    getJson(`api/changes?from=${encodeURIComponent(seen)}&to=${encodeURIComponent(version)}`).then((r) => {
      const sub = el.querySelector('[data-changes]');
      if (!sub) return;
      const items = (r?.changes || []).slice(0, 4); // the distilled list is already the curated summary
      const link = r?.url ? ` · <a data-gh href="${esc(r.url)}" target="_blank" rel="noopener">what’s new ↗</a>` : '';
      sub.innerHTML = (items.length ? items.map(esc).join(' · ') : 'Things may have moved — review Settings') + link;
    }).finally(() => {
      // Give the operator the full display interval AFTER the comments (or fail-soft fallback) render.
      if (shown === 'upgraded:' + version && el.isConnected) revealToast(el, { autoDismiss: UPGRADE_NOTICE_MS });
    });
  }

  // Local: this server moved to a newer build than the page — reload to pick it up.
  function showReloadToast(version, isStable) {
    shown = 'reload:' + version;
    const el = toastEl();
    el.title = 'Reload to load the new version';
    el.onclick = () => reloadLatest();
    el.innerHTML =
      `<span class="vt-up">↑</span>` +
      `<span class="vt-text"><span class="vt-line">New ${isStable ? 'stable ' : ''}version <b>v${version}</b></span>` +
      `<span class="vt-sub">Reload to update</span></span>` +
      `<span class="vt-icon">⟳</span>`;
    revealToast(el);
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
        e.preventDefault();
        e.stopPropagation();
        dismissToast('upstream:' + u.version);
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
    revealToast(el);
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
    revealToast(el);
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
    serverVersion = version;
    publishVersion(version);
    if (baseline == null) { baseline = version; checkUpgraded(version, v?.channel); } // first read = the running build
    const mode = releaseNotify();
    if (mode === 'off') return; // release notifications disabled entirely — no reload nudge, no upstream nudge
    if (version !== baseline) {
      // Skip the toast for a routine every-release bump when on "stable only" — the user stays put until a
      // blessed stable release lands (channel === 'stable'). "every release" always shows it.
      const gated = mode === 'stable' && v?.channel && v.channel !== 'stable';
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
  addEventListener('resize', () => positionToast(document.getElementById('aios-version-toast')), { passive: true });
  addEventListener('aios:open-update', openUpdateControl);
  document.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-aios-update]')) {
      event.preventDefault();
      openUpdateControl();
      return;
    }
    if (event.target.closest?.('[data-update-close]')) closeUpdateControl();
    if (event.target.closest?.('[data-update-check]')) inspectLatest();
    if (event.target.closest?.('[data-update-reload]')) reloadLatest();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !document.getElementById('aios-update-control')?.hidden) closeUpdateControl();
  });
})();
