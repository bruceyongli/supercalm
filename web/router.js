// Single-shell SPA controller. ONE persistent sidebar (mountShell, called exactly once) + a #view
// container whose contents are swapped by a client router — no page reload on any page/session switch.
// Views are modules exporting init(host, params) + teardown(); the router tears the current one down,
// swaps #view, mounts the next, and pushState's the URL. Built alongside the legacy pages (served at
// /aios/app) until verified, then the server points every app route here (see src/server.js).
import { mountShell } from './shell.js';

const BASE = '/aios';                        // path prefix the app is served under
const view = () => document.getElementById('view');

// Route table: first match wins. `load` dynamic-imports the view module (code-split, cached after first
// visit); `nav` is the sidebar item to mark active. The session route carries no active nav item.
const ROUTES = [
  { re: /^\/(?:index\.html)?$/, load: () => import('./views/dashboard.js'), nav: 'inbox' },
  { re: /^\/session$/, load: () => import('./views/session-view.js'), nav: '' },
  { re: /^\/projects$/, load: () => import('./views/projects.js'), nav: 'projects' },
  { re: /^\/decisions$/, load: () => import('./views/decisions.js'), nav: 'decisions' },
  { re: /^\/records$/, load: () => import('./views/records.js'), nav: 'records' },
  { re: /^\/usage$/, load: () => import('./views/usage.js'), nav: 'usage' },
  { re: /^\/health$/, load: () => import('./views/health.js'), nav: 'health' },
  { re: /^\/settings$/, load: () => import('./views/settings.js'), nav: 'settings' },
];

let current = null;      // { teardown, update? } of the mounted view
let currentRoute = null; // the ROUTES entry currently mounted (to detect same-route param changes)
let navToken = 0;        // guards against a slow import landing after a newer navigation

function appPath() {
  // location.pathname is e.g. "/aios/session"; strip the base to get the app route "/session".
  let p = location.pathname;
  if (p.startsWith(BASE)) p = p.slice(BASE.length) || '/';
  return p || '/';
}
function routeFor(p) { return ROUTES.find((r) => r.re.test(p)) || ROUTES[0]; }

function setActiveNav(nav) {
  for (const a of document.querySelectorAll('.dk-nav-item')) a.classList.toggle('active', !!nav && a.dataset.nav === nav);
}

async function render() {
  const token = ++navToken;
  const p = appPath();
  const r = routeFor(p);
  const params = Object.fromEntries(new URLSearchParams(location.search));
  setActiveNav(r.nav);
  document.body.classList.toggle('session-page', p === '/session'); // the session view drives its own full-bleed layout
  // Same view module + only params changed (session A → session B) AND the view supports in-place update:
  // update WITHOUT tearing down/remounting, so the session switch stays a no-reload swap.
  if (r === currentRoute && current && typeof current.update === 'function') {
    try { current.update(params); } catch (e) { console.error('view update error:', e); }
    return;
  }
  // tear down the outgoing view (clears its intervals/streams/observers) then clear the container
  try { current?.teardown?.(); } catch (e) { console.error('view teardown error:', e); }
  current = null; currentRoute = null;
  const host = view();
  if (host) host.innerHTML = '<div class="view-loading"></div>';
  let mod;
  try { mod = await r.load(); } catch (e) { if (token === navToken && host) host.innerHTML = `<div class="dk-allclear">Failed to load view: ${e.message || e}</div>`; return; }
  if (token !== navToken) return; // a newer navigation superseded this one mid-import
  try { await mod.init(host, params); current = mod; currentRoute = r; } catch (e) { console.error('view init error:', e); if (host) host.innerHTML = `<div class="dk-allclear">View error: ${e.message || e}</div>`; }
}

// Navigate without a reload. Same-route with different params (session?id=A -> session?id=B) still
// re-renders so the target view re-keys on the new params.
export function go(href, { push = true } = {}) {
  let url;
  try { url = new URL(href, location.href); } catch { return; }
  if (url.origin !== location.origin) { location.href = href; return; } // external — real navigation
  if (push) history.pushState({}, '', url); else history.replaceState({}, '', url);
  render();
}

// Intercept in-app link clicks (sidebar nav, session rows, inbox cards). Anything with target=_blank, a
// modifier key, or an off-origin/hash/scheme href is left to the browser.
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a[href]');
  if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
  const href = a.getAttribute('href');
  if (!href) return;
  if (href.startsWith('#')) {
    // In-page anchor. The browser CANNOT be left to handle this: the app ships <base href="/aios/">,
    // so a bare "#x" resolves against the BASE and really navigates to /aios/#x — the dashboard
    // (observed: the settings sub-nav "redirected home"). Scroll in place instead.
    e.preventDefault();
    document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState({}, '', location.pathname + location.search + href);
    return;
  }
  if (/^[a-z]+:/i.test(href)) return; // scheme (mailto:, http:) — leave it
  let url;
  try { url = new URL(href, location.href); } catch { return; }
  if (url.origin !== location.origin) return;
  const appP = url.pathname.startsWith(BASE) ? url.pathname.slice(BASE.length) || '/' : url.pathname;
  if (!ROUTES.some((r) => r.re.test(appP))) return; // unknown path (auth/onboarding/phone) — real navigation
  e.preventDefault();
  go(url.href);
}, true); // capture phase, before per-view handlers that might stopPropagation

window.addEventListener('popstate', () => render());

// Mount the persistent sidebar ONCE, then render the initial route into #view.
mountShell({});
render();
