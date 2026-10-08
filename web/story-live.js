// Compact transcript notifications, independent of terminal rendering/status transitions. Open
// immediately (not requestIdleCallback); stop in hidden views and catch up after mobile suspension.
export function createStoryLive({ sessionId, refresh, pause = () => {}, signal,
  minIntervalMs = 350, recoveryMs = 15000 } = {}) {
  let stream = null, timer = null, repair = null, active = false, closed = false;
  let lastRequest = 0, lastEvent = 0, failures = 0;
  const canRun = () => active && !closed && !signal?.aborted && !document.hidden;
  function run() {
    timer = null;
    if (!canRun()) return;
    lastRequest = Date.now();
    Promise.resolve(refresh({ quiet: true, followUp: true })).then(result => {
      if (result !== false) { failures = 0; return; }
      retry();
    }).catch(retry);
  }
  function retry() {
    if (canRun() && !timer) timer = setTimeout(run, Math.min(5000, 1000 * 2 ** Math.min(failures++, 3)));
  }
  const request = () => {
    if (!canRun() || timer) return;
    timer = setTimeout(run, Math.max(0, minIntervalMs - (Date.now() - lastRequest)));
  };
  function disconnect() {
    clearTimeout(timer); clearInterval(repair); timer = null; repair = null;
    stream?.close(); stream = null;
    pause();
  }
  function connect() {
    if (!canRun() || stream) return;
    lastEvent = Date.now();
    stream = new EventSource(`api/session/${encodeURIComponent(sessionId)}/story/updates`);
    stream.addEventListener('open', request);
    stream.addEventListener('update', event => {
      try { if (JSON.parse(event.data).session !== sessionId) return; } catch { return; }
      lastEvent = Date.now(); request();
    });
    stream.addEventListener('heartbeat', () => { lastEvent = Date.now(); });
    stream.addEventListener('error', request); // native EventSource also reconnects and receives a fresh update
    repair = setInterval(() => {
      if (!canRun()) return;
      if (Date.now() - lastEvent > recoveryMs * 2) { disconnect(); connect(); }
      request(); // bounded cache-only repair, including a silently missed final report
    }, recoveryMs);
  }
  const wake = () => {
    if (!canRun()) { disconnect(); return; }
    connect(); request();
  };
  const visibility = () => { if (document.hidden) disconnect(); else wake(); };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', wake);
  window.addEventListener('focus', wake);
  const close = () => {
    if (closed) return;
    closed = true; disconnect();
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('online', wake); window.removeEventListener('pageshow', wake);
    window.removeEventListener('focus', wake);
    signal?.removeEventListener('abort', close);
  };
  signal?.addEventListener('abort', close, { once: true });
  return {
    setActive(value) {
      active = !!value;
      if (canRun()) { connect(); request(); } else disconnect();
    },
    close,
  };
}
