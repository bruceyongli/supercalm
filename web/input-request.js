// A lost response is an UNKNOWN delivery, not permission to send the instruction again.
// Bound both headers and JSON body; callers recover with the original id's read-only receipt.
export async function requestInputJson(url, { signal, timeoutMs = 15000, ...options } = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const response = await fetch(url, { ...options, cache: 'no-store', signal: controller.signal });
    const json = await response.json(); // partial JSON must never become a successful empty receipt
    return { response, json };
  } catch (error) {
    if (timedOut && !signal?.aborted) {
      throw Object.assign(new Error('Delivery confirmation timed out.'), { code: 'INPUT_TIMEOUT' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
