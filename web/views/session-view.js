// TEMPORARY stub for the session route. The real session view (xterm + agent panel + streams, with a full
// mount/teardown) is the next Track B step; until it lands, opening a session from the SPA shell does a
// normal navigation to the working legacy session page (session.html) so nothing is broken in the meantime.
export function init(host, params) {
  const id = params && params.id ? params.id : '';
  location.href = 'session?id=' + encodeURIComponent(id);
}
export function teardown() {}
