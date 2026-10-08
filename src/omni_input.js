// SAME-ORIGIN recognition adapter. Omni owns incremental ASR/reconnection; ALL
// final transcripts go to Supercalm's context/confirmation harness. No speculative
// LLM answer is started while deciding whether the operator asked for an action.
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { omniRequest, omniHttpError } from './omni_client.js';
import { SSEParser } from '../web/vendor/omni/voice-core.mjs';
import { OmniASR } from '../web/vendor/omni/omni-asr.mjs';

const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const fail = (message, status = 400) => Object.assign(new Error(message), { status, noFallback: true });
export function createOmniInput({ prepare, released, request = omniRequest }) {
  const starts = new Map(), sessions = new Map(), releasedOwners = new WeakSet();
  const call = async (method, path, options) => {
    const response = await request(method, '/voice/sessions' + path, options);
    if (response.status !== 200) throw omniHttpError(response);
    return response;
  };
  const release = session => {
    if (session.released) return;
    session.released = true;
    clearTimeout(session.lifetimeTimer);
    if (releasedOwners.has(session.owner)) return;
    releasedOwners.add(session.owner); released(session.owner);
  };
  const expire = entry => {
    clearTimeout(entry.retryTimer);
    entry.error = fail('Voice input recovery expired. No recording was resent.', 410);
    entry.abort?.abort();
    if (entry.owner) release(entry);
  };
  const prune = () => {
    for (const [key, entry] of starts) if (Date.now() - entry.created > 180000) {
      if (entry.session) { sessions.delete(entry.session.id); release(entry.session); }
      else expire(entry);
      starts.delete(key);
    }
  };
  const find = id => {
    prune();
    const session = validId(id) && sessions.get(id);
    if (!session) throw fail('Voice input session expired. No recording was resent.', 410);
    if (!session.owner.alive()) throw fail('The displayed report changed. No feedback was sent.', 410);
    return session;
  };
  const stop = async (session, reason = 'client_stop') => {
    if (!session.stopping) session.stopping = (async () => {
      try { await call('DELETE', '/' + session.id, { body: { reason }, timeout: 3000,
        signal: AbortSignal.timeout(3500), maxBytes: 64000 }); }
      finally { release(session); }
    })();
    return session.stopping;
  };
  return {
    async start(body) {
      prune();
      if (!validId(body.client_session_id) || typeof body.voiceId !== 'string') throw fail('Invalid voice input identity');
      if (body.model !== undefined && body.model !== 'omni-voice') throw fail('Invalid voice input model');
      if (body.asr_only !== true || body.continuous !== false) throw fail('Reload the voice assistant to use recognition-only input', 409);
      if ((body.language !== undefined && body.language !== 'auto')
        || (body.app_id !== undefined && body.app_id !== 'supercalm')) throw fail('Invalid recognition options');
      // Business owner comes from the server. A browser cannot replace it, supply
      // arbitrary prompts, select another upstream, or inject a tool call.
      if (Object.keys(body).some(key => !['model', 'voiceId', 'client_session_id', 'asr_only', 'continuous', 'language', 'app_id'].includes(key))) throw fail('Voice input options are server-owned');
      const key = body.client_session_id, fingerprint = createHash('sha256')
        .update(JSON.stringify([body.voiceId, body.model, key])).digest('hex');
      let entry = starts.get(key);
      if (entry && entry.fingerprint !== fingerprint) throw fail('Voice input identity changed', 409);
      if (!entry) {
        if (starts.size >= 256) throw fail('Voice input capacity is full', 429);
        entry = { fingerprint, created: Date.now(), voiceId: body.voiceId };
        starts.set(key, entry);
      }
      if (entry.error) throw entry.error;
      if (entry.owner && !entry.owner.alive()) { expire(entry); throw entry.error; }
      if (entry.session) return entry.descriptor; // lost browser ACK: SAME upstream
      if (entry.promise) return entry.promise;
      entry.promise = (async () => {
        try {
          const owner = entry.owner ||= await prepare(body.voiceId);
          if (entry.error || !owner.alive()) throw entry.error || fail('Voice report expired', 410);
          // A lost UPSTREAM creation ACK must also recover with the SAME frozen
          // owner. Never prepare/reserve again or cache a rejected promise. ASR
          // accepts no voice, history, character, LLM route or source documents.
          entry.payload ||= { model: 'omni-voice', app_id: 'supercalm', asr_only: true,
            continuous: false, language: 'auto', client_session_id: key };
          entry.abort = new AbortController();
          const response = await call('POST', '', { body: entry.payload, signal: entry.abort.signal,
            timeout: 10000, maxBytes: 64000 });
          const descriptor = JSON.parse(response.body.toString('utf8'));
          if (!validId(descriptor.session_id) || descriptor.protocol !== 'omni-voice-stream-v1'
            || descriptor.asr_only !== true || descriptor.input_mode !== 'asr-only'
            || descriptor.continuous !== false || descriptor.max_audio_seconds !== 30) {
            if (validId(descriptor.session_id)) call('DELETE', '/' + descriptor.session_id,
              { body: { reason: 'incompatible_recognition' }, timeout: 3000 }).catch(() => {});
            throw fail('Voice gateway did not confirm recognition-only mode. No audio was uploaded.', 502);
          }
          const session = { id: descriptor.session_id, owner, cursor: 0,
            validator: new OmniASR({ continuous: false }), final: '' };
          entry.session = session; sessions.set(session.id, session);
          // The upstream session's 105s lifetime is not extended by reconnects.
          // Even a vanished browser must eventually release our business owner.
          session.lifetimeTimer = setTimeout(() => stop(session, 'session_expired').catch(() => {}),
            Math.max(1, 105000 - (Date.now() - entry.created))).unref();
          clearTimeout(entry.retryTimer);
          if (entry.error || !owner.alive()) { stop(session).catch(() => {}); throw entry.error || fail('Voice report expired', 410); }
          entry.descriptor = descriptor;
          return descriptor;
        } catch (error) {
          if (!entry.error && entry.owner && (!error.status || error.status === 503)) {
            error.status = 503;
            entry.retryTimer ||= setTimeout(() => expire(entry), 45000).unref();
          } else {
            entry.error ||= error;
            if (entry.owner) release(entry);
          }
          throw entry.error || error;
        } finally { entry.promise = null; }
      })();
      // No unhandled rejection while a lost browser ACK is recovered.
      entry.promise.catch(() => {});
      return entry.promise;
    },
    async control(id, method, action, body) {
      const session = find(id);
      if (method === 'DELETE') { await stop(session, body.reason); return { stopped: true }; }
      // Upstream owns accepting/idempotency checks. A lost commit ACK may be
      // retried AFTER done/handoff released capacity; rejecting it here would
      // discard the already-final transcript on a weak mobile connection.
      if (action === 'audio') {
        if (!Number.isSafeInteger(body.sequence) || body.sequence < 0 || body.sequence > 4096
          || typeof body.audio !== 'string' || body.audio.length > 43000
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio) || body.audio.length % 4
          || Object.keys(body).some(key => !['audio', 'sequence'].includes(key))) throw fail('Invalid PCM audio chunk');
      } else if (action !== 'commit' || Object.keys(body).length) throw fail('Invalid voice input action');
      const response = await call(method, '/' + id + '/' + action, { body, timeout: 10000, maxBytes: 64000 });
      return JSON.parse(response.body.toString('utf8'));
    },
    async events(id, after, res) {
      const session = find(id);
      if (!/^(?:0|[1-9]\d{0,5})$/.test(after)) throw fail('Invalid voice event cursor');
      const ctrl = new AbortController(), decoder = new StringDecoder('utf8');
      // Relay application keepalives even while the parser consumes upstream
      // comment heartbeats. Silence/queue wait is not a disconnected SSE reader.
      const heartbeat = setInterval(() => {
        if (res.headersSent && !res.destroyed && !res.writableEnded && res.writableLength < 256000) {
          res.write(': voice-waiting\n\n');
        }
      }, 5000).unref();
      const disconnect = () => { if (!res.writableEnded) ctrl.abort(); };
      res.on('close', disconnect); res.on('error', disconnect);
      const parser = new SSEParser((name, data, eventId) => {
        if (!session.owner.alive()) throw fail('Voice report changed', 410);
        if (!/^\d+$/.test(eventId || '')) throw fail('Missing upstream voice event identity', 502);
        const sequence = Number(eventId), fresh = sequence > session.cursor;
        if (fresh) {
          if (sequence !== session.cursor + 1) throw fail('Missing upstream voice event', 502);
          if (!session.failed) {
            try { session.validator.event(name, data); }
            catch (error) {
              session.failed = { id: eventId, message: error.message };
              stop(session).catch(() => {});
              name = 'error'; data = { message: error.message, code: 'asr_protocol', noFallback: true };
            }
            if (name === 'transcript_final' && !session.failed) session.final = session.validator.confirmedText;
            // A successful ASR done is authoritative even if commit's HTTP ACK
            // was lost. Release before /turn, not behind a slow DELETE response.
            if (['done', 'error', 'retry'].includes(name)) release(session);
          }
          session.cursor = sequence;
        }
        if (session.failed) {
          if (session.failed.id !== eventId) return;
          name = 'error'; data = { message: session.failed.message, code: 'asr_protocol', noFallback: true };
        }
        if (name === 'transcript_final') data = { ...data, aios_handoff: true };
        res.write(`id: ${eventId}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      });
      try {
        const response = await call('GET', '/' + id + '/events?after=' + after, { signal: ctrl.signal,
          timeout: 110000, maxBytes: 18000000, onChunk(chunk, upstream) {
            if (!String(upstream.headers['content-type']).startsWith('text/event-stream')) throw fail('Invalid upstream voice events', 502);
            if (!res.headersSent) {
              res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform' }); res.flushHeaders?.();
            }
            parser.feed(decoder.write(chunk));
            if (res.writableLength > 256000 && !upstream.isPaused()) { upstream.pause(); res.once('drain', () => upstream.resume()); }
          } });
        if (response.status !== 200) throw omniHttpError(response);
        parser.feed(decoder.end());
        if (!res.destroyed) res.end();
      } catch (error) {
        // A reader disconnect only detaches: upstream retains the SAME session
        // and bounded journal for VoiceStreamClient to reconnect with `after`.
        if (!ctrl.signal.aborted && !res.destroyed) {
          if (error.status === 404 || error.status === 410) release(session);
          if (!res.headersSent) throw error;
          res.destroy(); // no invented SSE id/terminal that would poison replay
        }
      } finally { clearInterval(heartbeat); res.off('close', disconnect); res.off('error', disconnect); }
    },
    cancelOwner(voiceId) {
      for (const entry of starts.values()) if (entry.voiceId === voiceId && !entry.session) expire(entry);
      for (const session of sessions.values()) if (session.owner.voiceId === voiceId) stop(session).catch(() => {});
    },
  };
}
