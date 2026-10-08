// Replay only transport events from one server generation; never retry an LLM/TTS request.
export async function* voiceStreamEvents(live, signal) {
  const requestId = crypto.randomUUID();
  let after = 0, resumable = false, terminal = false, retries = 0, receivedText = '', shownText = '';
  let pollTimer = null, cancelled = false;
  const showText = text => {
    if (text.length <= shownText.length || !text.startsWith(shownText)) return '';
    const delta = text.slice(shownText.length); shownText = text; return delta;
  };
  const body = { ...live.body, requestId };
  const cancel = () => {
    clearTimeout(pollTimer);
    // Explicit interruption/end cancels generation promptly. A broken download alone is resumable.
    if (!terminal && resumable && !cancelled) {
      cancelled = true;
      fetch('api/voice/conversation/cancel', { method: 'POST', keepalive: true,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
    }
  };
  const poll = async () => {
    if (signal.aborted || terminal) return;
    const ctrl = new AbortController(), abort = () => ctrl.abort();
    const deadline = setTimeout(abort, 5000);
    signal.addEventListener('abort', abort, { once: true });
    try {
      const r = await fetch('api/voice/conversation/progress', { method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) {
        const progress = await r.json();
        const delta = showText(String(progress.text || ''));
        if (delta) live.onText?.(delta);
        live.onProgress?.(progress);
        if (progress.complete) return; // text is complete; audio still MUST drain through SSE
      }
    } catch {} finally { clearTimeout(deadline); signal.removeEventListener('abort', abort); }
    if (!signal.aborted && !terminal) pollTimer = setTimeout(poll, 1500);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!signal.aborted) {
      try {
        const r = await fetch(live.path, { method: 'POST', signal, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, ...(retries ? { resume: true, afterEvent: after } : {}) }) });
        if (!r.ok || !r.body?.getReader) {
          const error = await r.json().catch(() => ({}));
          throw Object.assign(new Error(error.error || 'voice stream ' + r.status), { noResume: true, noFallback: true });
        }
        resumable = r.headers.get('x-aios-voice-resumable') === '1';
        if (!String(r.headers.get('content-type')).startsWith('text/event-stream')) throw Object.assign(new Error('Invalid voice stream'), { noResume: true });
        if (resumable && !pollTimer && !retries) pollTimer = setTimeout(poll, 800);
        const reader = r.body.getReader(), decoder = new TextDecoder(); let buffer = '';
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end;
            while ((end = buffer.indexOf('\n\n')) !== -1) {
              const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const lines = block.split(/\r?\n/);
              const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
              const dataLines = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
              if (!event || !dataLines.length) continue;
              const sequence = Number(lines.find(line => line.startsWith('id:'))?.slice(3).trim());
              if (resumable && (!Number.isSafeInteger(sequence) || sequence <= 0)) throw Object.assign(new Error('Invalid voice event identity'), { noResume: true });
              if (resumable && sequence <= after) continue;
              if (resumable && sequence !== after + 1) throw Object.assign(new Error('Missing voice event'), { noResume: true });
              const data = JSON.parse(dataLines.join('\n'));
              if (resumable) after = sequence;
              if (event === 'text') {
                receivedText += String(data.delta || '');
                data.delta = showText(receivedText);
              }
              if (event === 'error' || event === 'retry' || event === 'done') terminal = true;
              live.onConnected?.();
              yield { event, data };
            }
            if (buffer.length > 1000000) throw Object.assign(new Error('Voice event exceeds limit'), { noResume: true });
          }
        } finally { reader.releaseLock(); }
        if (terminal || !resumable) return;
        throw new Error('Voice download interrupted');
      } catch (error) {
        if (signal.aborted || terminal || !resumable || error.noResume || retries >= 4) throw error;
        retries++;
        live.onReconnecting?.();
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, Math.min(2500, retries * 500)); signal.addEventListener('abort', done, { once: true });
        });
      }
    }
  } finally {
    clearTimeout(pollTimer); signal.removeEventListener('abort', cancel);
    if (!terminal) cancel();
  }
}
