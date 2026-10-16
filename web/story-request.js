// Story is a read-only, potentially large JSON response. A total 20s fetch deadline killed
// progressing mobile downloads; api() also masks JSON/body failures as {}, losing their retry.
export async function requestStory(path, { signal, headerTimeoutMs = 60000,
  idleTimeoutMs = 20000, maxDurationMs = 180000 } = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  let idle, reader, timedOut = false;
  const timeout = () => { timedOut = true; controller.abort(); };
  const arm = ms => { clearTimeout(idle); idle = setTimeout(timeout, ms); };
  const deadline = setTimeout(timeout, maxDurationMs);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  arm(headerTimeoutMs);
  try {
    const response = await fetch(path, { signal: controller.signal });
    arm(idleTimeoutMs);
    reader = response.body?.getReader();
    if (!reader) throw Object.assign(new Error('Story download was interrupted.'), { code: 'STORY_INCOMPLETE' });
    const decoder = new TextDecoder(), parts = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value?.byteLength) { arm(idleTimeoutMs); parts.push(decoder.decode(value, { stream: true })); }
    }
    parts.push(decoder.decode());
    let body;
    try { body = JSON.parse(parts.join('')); } catch {
      if (response.ok) throw Object.assign(new Error('Story download was incomplete.'), { code: 'STORY_INCOMPLETE' });
    }
    if (!response.ok) throw Object.assign(new Error(body?.error || `HTTP ${response.status}`), { status: response.status, code: body?.code });
    if (!Array.isArray(body?.events)) throw Object.assign(new Error('Story response was incomplete.'), { code: 'STORY_INCOMPLETE' });
    return body;
  } catch (error) {
    if (timedOut && !signal?.aborted) throw Object.assign(new Error('Story connection timed out.'), { code: 'STORY_TIMEOUT' });
    throw error;
  } finally {
    clearTimeout(idle); clearTimeout(deadline);
    signal?.removeEventListener('abort', cancel);
    reader?.releaseLock();
  }
}

export function interruptedStoryRequest(error) {
  return ['STORY_TIMEOUT', 'STORY_INCOMPLETE'].includes(error?.code)
    || ['AbortError', 'TimeoutError', 'TypeError'].includes(error?.name)
    || error?.status >= 500 || error?.status === 408 || error?.status === 429;
}
