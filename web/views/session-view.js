// Session view. Mounts the REAL session view (web/session.js) directly into the SPA #view — no iframe. The
// session module is a singleton, so we import it once and drive it through its mount/teardown/switch
// contract: init() → mountSession(host, {embedded:true}) (the parent shell owns the ONE sidebar + data
// loop, so the session skips its own); update() remounts only #view for a no-document-reload
// session→session swap;
// teardown() → destroySession() for a full reset so the next mount starts clean.
// View contract: export init(host, params, navigation) + update(params) + teardown().
import { navigate } from '../navigation.js';

let mod = null;
let curId = null;
let hostEl = null;
const vendorLoads = new Map();

// The SPA shell (web/app.html) doesn't load the xterm vendor bundles (the old iframe pulled them in via
// session.html); the session view needs them for `new Terminal()` / `FitAddon`. Load them once, idempotently,
// before mounting. Classic <script> tags set the UMD globals reliably (a bare dynamic import of a UMD bundle
// does not always assign the global — same technique as web/agents/graph.js).
function loadScript(src) {
  if (vendorLoads.has(src)) return vendorLoads.get(src);
  const promise = new Promise((resolve, reject) => {
    const id = 'vendorjs-' + src.replace(/\W/g, '');
    let script = document.getElementById(id);
    const loaded = () => {
      script.dataset.loaded = '1';
      resolve();
    };
    const failed = () => reject(new Error('failed to load ' + src));
    if (script?.dataset.loaded === '1') return resolve();
    if (!script) {
      script = document.createElement('script');
      script.id = id;
      script.src = new URL(src, document.baseURI).href;
      document.head.appendChild(script);
    }
    script.addEventListener('load', loaded, { once: true });
    script.addEventListener('error', failed, { once: true });
  });
  vendorLoads.set(src, promise);
  promise.catch(() => vendorLoads.delete(src));
  return promise;
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

export async function init(host, params, navigation = {}) {
  const nextId = params && params.id ? params.id : '';
  // Resolve every cold-load dependency before claiming the shared host or module-level session identity.
  // If navigation moves elsewhere during this await, the aborted initializer remains a pure no-op.
  const [m] = await Promise.all([import('../session.js'), ensureXterm()]);
  if (navigation.signal?.aborted || (navigation.isCurrent && !navigation.isCurrent())) return;
  hostEl = host;
  curId = nextId;
  mod = m;
  host.innerHTML = ''; // clear the router's loading placeholder so mountSession injects fresh markup
  mod.mountSession(host, { id: curId, embedded: true });
}

// Same-route nav (session A → session B): rebuild only the session view inside the persistent SPA shell.
// This keeps the document/sidebar while giving every session its own immutable identity and async scope.
export function update(params) {
  const nid = params && params.id ? params.id : '';
  if (!nid || nid === curId) return;
  curId = nid;
  try {
    mod?.destroySession();
    hostEl.innerHTML = '';
    mod?.mountSession(hostEl, { id: nid, embedded: true });
  } catch {
    navigate(`session?id=${encodeURIComponent(nid)}`);
  }
}

export function teardown() {
  try { mod?.destroySession(); } catch {}
  curId = null;
  hostEl = null;
}
