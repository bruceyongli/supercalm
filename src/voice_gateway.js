// Shared, read-only Omni conversation transport; model speech can never send coding-agent input.
import { createNativeSpeechDecoder } from './tts_native.js';
import { omniRequest, omniHttpError } from './omni_client.js';
export { gatewayConversation, utf8Limit } from './voice_gateway_context.js';

export async function relayOmniConversation(payload, { res, signal, onEvent, emit }) {
  const decoder = createNativeSpeechDecoder(null, { voice: payload.voice });
  const send = emit || ((event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  let started = false;
  const response = await omniRequest('POST', '/voice/turns', {
    body: { model: 'omni-voice', app_id: 'supercalm', reply_reconnect: true, ...payload },
    signal, timeout: 60000, maxBytes: 18000000,
    onChunk(chunk, upstream) {
      if (!String(upstream.headers['content-type']).startsWith('text/event-stream')) throw new Error('Expected Omni voice stream');
      let writable = true;
      for (const event of decoder.feed(chunk)) {
        if (event.event === 'transcript' || event.event === 'done') continue;
        if (!started) {
          started = true;
          if (!emit) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
          send('metadata', { transport: 'native-pcm-frames', voice: payload.voice });
        }
        onEvent?.(event);
        writable = send(event.event, event.data) && writable;
      }
      if (!emit && !writable && !upstream.isPaused()) { upstream.pause(); res.once('drain', () => upstream.resume()); }
    },
  });
  if (response.status !== 200) throw omniHttpError(response);
  return decoder.finish();
}
