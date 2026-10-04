// Lost HTTP acknowledgements cannot deliver feedback twice or advance the voice queue twice.
// This ledger only caches successful control replies, never retries models or changes dialogue.
export function createVoiceControlReplay({ now = Date.now, ttlMs = 30 * 60 * 1000, max = 200 } = {}) {
  const replies = new Map();
  const key = (path, body) => body.voiceId && typeof body.requestId === 'string' && body.requestId.length <= 128
    ? `${path}:${body.voiceId}:${body.requestId}` : '';
  return {
    get(path, body) {
      const entry = replies.get(key(path, body));
      if (!entry || now() - entry.at > ttlMs) return null;
      return entry.response;
    },
    record(path, body, status, response) {
      const id = key(path, body);
      if (!id || status !== 200) return;
      replies.set(id, { at: now(), response });
      for (const [id, entry] of replies) if (now() - entry.at > ttlMs) replies.delete(id);
      while (replies.size > max) replies.delete(replies.keys().next().value);
    },
  };
}
