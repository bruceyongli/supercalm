// Session view. The session page (web/session.js, ~3200 lines of interleaved import-time setup wired to
// xterm + the agent panel + two SSE streams) runs in an embedded iframe inside #view — that keeps the
// battle-tested surface 100% intact while the SPA shell owns the ONE persistent flush sidebar. The only
// session-side changes are guarded by ?embed=1 (session.js/styles.css), so the legacy standalone page is
// unaffected. dashboard→session mounts the iframe (one load); session→session is in-place via update()
// → postMessage → the iframe's switchSession (NO iframe reload); leaving the view removes the iframe.
let frame = null;
let curId = null;

export function init(host, params) {
  curId = params && params.id ? params.id : '';
  host.innerHTML = '';
  frame = document.createElement('iframe');
  frame.className = 'spa-session-frame';
  frame.setAttribute('title', 'session');
  frame.src = `session?id=${encodeURIComponent(curId)}&embed=1`;
  host.appendChild(frame);
}

// Same-route nav (session A → session B): switch IN PLACE inside the iframe instead of remounting it, so
// the operator's existing no-reload session switch is preserved.
export function update(params) {
  const nid = params && params.id ? params.id : '';
  if (!nid || nid === curId) return;
  curId = nid;
  try { frame?.contentWindow?.postMessage({ type: 'aios-switch-session', id: nid }, location.origin); }
  catch { if (frame) frame.src = `session?id=${encodeURIComponent(nid)}&embed=1`; }
}

export function teardown() {
  if (frame) { try { frame.src = 'about:blank'; } catch {} frame.remove(); frame = null; }
  curId = null;
}
