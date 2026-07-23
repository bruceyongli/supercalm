// Owns the lifetime of asynchronous work for the currently selected session. A session switch aborts
// fetches from the old identity and advances a generation token, so a late response cannot paint into the
// new session even when the underlying operation ignored AbortSignal.
export function createSessionRequestScope(initialId) {
  let id = String(initialId || '');
  let generation = 1;
  let controller = new AbortController();

  function capture() {
    return { id, generation, signal: controller.signal };
  }
  function isCurrent(token) {
    return !!token && !token.signal.aborted && token.id === id && token.generation === generation;
  }
  function switchTo(nextId) {
    const next = String(nextId || '');
    if (!next || next === id) return capture();
    controller.abort();
    controller = new AbortController();
    id = next;
    generation++;
    return capture();
  }
  function guard(token, value) {
    if (!isCurrent(token)) {
      const error = new Error('stale session request');
      error.name = 'AbortError';
      throw error;
    }
    return value;
  }
  function destroy() {
    controller.abort();
    generation++;
  }
  return { capture, isCurrent, switchTo, guard, destroy };
}

export function isSessionAbort(error) {
  return error?.name === 'AbortError';
}
