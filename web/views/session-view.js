// Session view. Mounts the REAL session view (web/session.js) directly into the SPA #view — no iframe. The
// session module is a singleton, so we import it once and drive it through its mount/teardown/switch
// contract: init() → mountSession(host, {embedded:true}) (the parent shell owns the ONE sidebar + data
// loop, so the session skips its own); update() → switchSession() for a no-reload session→session swap;
// teardown() → destroySession() for a full reset so the next mount starts clean.
// View contract: export init(host, params) + update(params) + teardown().
import { navigate } from '../navigation.js';

let mod = null;
let curId = null;

// The SPA shell (web/app.html) doesn't load the xterm vendor bundles (the old iframe pulled them in via
// session.html); the session view needs them for `new Terminal()` / `FitAddon`. Load them once, idempotently,
// before mounting. Classic <script> tags set the UMD globals reliably (a bare dynamic import of a UMD bundle
// does not always assign the global — same technique as web/agents/graph.js).
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const id = 'vendorjs-' + src.replace(/\W/g, '');
    if (document.getElementById(id)) return resolve();
    const s = document.createElement('script');
    s.id = id;
    s.src = new URL(src, document.baseURI).href;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}
async function ensureXterm() {
  if (!document.getElementById('vendor-xterm-css')) {
    const l = document.createElement('link');
    l.id = 'vendor-xterm-css';
    l.rel = 'stylesheet';
    l.href = new URL('vendor/xterm.css', document.baseURI).href;
    document.head.appendChild(l);
  }
  if (!window.Terminal) await loadScript('vendor/xterm.js');
  if (!window.FitAddon) await loadScript('vendor/xterm-fit.js');
}

export async function init(host, params) {
  curId = params && params.id ? params.id : '';
  host.innerHTML = ''; // clear the router's loading placeholder so mountSession injects fresh markup
  const [m] = await Promise.all([import('../session.js'), ensureXterm()]);
  mod = m;
  mod.mountSession(host, { id: curId, embedded: true });
}

// Same-route nav (session A → session B): switch IN PLACE via the session's own no-reload switch instead
// of tearing down + remounting — preserves the operator's existing in-place session switch.
export function update(params) {
  const nid = params && params.id ? params.id : '';
  if (!nid || nid === curId) return;
  curId = nid;
  try { mod?.switchSession(nid); } catch { navigate(`session?id=${encodeURIComponent(nid)}`); }
}

export function teardown() {
  try { mod?.destroySession(); } catch {}
  curId = null;
}
