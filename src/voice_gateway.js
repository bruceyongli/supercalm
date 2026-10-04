// Shared, read-only Omni conversation transport; model speech can never send coding-agent input.
import { createNativeSpeechDecoder } from './tts_native.js';
import { sparkRequest } from './spark.js';
export { gatewayConversation, utf8Limit } from './voice_gateway_context.js';

export async function relayOmniConversation(payload, { res, signal, onEvent }) {
  const decoder = createNativeSpeechDecoder(null, { voice: payload.voice });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const response = await sparkRequest('POST', '/voice/api/turn', {
    body: Buffer.from(JSON.stringify(payload)), contentType: 'application/json',
    headers: { 'X-Voice-Demo': '1' }, signal, timeout: 60000, maxBytes: 18000000,
    onChunk(chunk, upstream) {
      if (!String(upstream.headers['content-type']).startsWith('text/event-stream')) throw new Error('Expected Omni voice stream');
      let writable = true;
      for (const event of decoder.feed(chunk)) {
        if (event.event === 'transcript' || event.event === 'done') continue;
        if (!res.headersSent) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
          send('metadata', { transport: 'native-pcm-frames', voice: payload.voice });
        }
        onEvent?.(event);
        writable = send(event.event, event.data) && writable;
      }
      if (!writable && !upstream.isPaused()) { upstream.pause(); res.once('drain', () => upstream.resume()); }
    },
  });
  if (response.status !== 200) throw Object.assign(new Error(response.status === 429
    ? 'Voice is busy. Your question is kept; please retry when ready.' : 'Voice is temporarily unavailable. Your question is kept.'), { status: response.status === 429 ? 429 : 503 });
  return decoder.finish();
}
