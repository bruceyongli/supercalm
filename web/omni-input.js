// Browser/business adapter. Mic capture, encoding, VAD, resumable uploads, SSE,
// PCM playback and its cadence are Omni's unmodified shared implementations.
import { VoiceActivity } from './vendor/omni/voice-core.mjs';
import { VoiceStreamCapture } from './vendor/omni/voice-stream-capture.mjs';
import { consumeSpeech } from './vendor/omni/omni-speech.mjs';
import { createPcmQueue } from './voice-stream.js';

const loaded = new WeakSet();
export async function listenOmni({ context, voiceId, voice, signal, onPartial, onFinal,
  onText, onSpeaking, onSegment, onConnection, onLevel, installCommit, recording } = {}) {
  let stream, source, captureNode, gain, capture, final = '', handoff = false,
    ignoredReason = '', answered = false, answerText = '', sawAnswer = false, finalDelivered = false,
    recordingTimer, idleTimer, committing = false;
  const queue = createPcmQueue(context, { voice, onSegment });
  const abort = new AbortController();
  const stop = () => { abort.abort(); queue.stop(); capture?.stop(); };
  signal?.addEventListener('abort', stop, { once: true });
  const hidden = () => { if (document.hidden) stop(); };
  document.addEventListener('visibilitychange', hidden);
  const callbacks = { onPartial: data => onPartial?.(String(data.text || '')),
    onConnection, clientOptions: { base: 'api/voice/input/sessions', headers: {} } };
  let failCapture;
  const failed = new Promise((_, reject) => { failCapture = reject; });
  failed.catch(() => {});
  callbacks.onError = failCapture;
  const receiveFinal = data => {
    final = String(data.text || ''); ignoredReason = data.ignoredReason || '';
    if (!finalDelivered) { finalDelivered = true; onFinal?.(final); }
    if (data.aios_handoff) handoff = true;
  };
  const observe = value => {
    // Application/UI hook around the shared client's callback, not a second
    // protocol or capture implementation. A commit ACK can disappear AFTER the
    // final SSE arrived; retain that final text even if commit recovery expires.
    const deliver = value.client.onEvent;
    value.client.onEvent = (name, data) => {
      if (name === 'transcript_final') receiveFinal(data);
      if (name === 'text' || name === 'audio') sawAnswer = true;
      deliver(name, data);
      if (handoff) stop();
    };
    return value;
  };
  const stopMicrophone = () => {
    clearTimeout(recordingTimer); clearTimeout(idleTimer);
    if (captureNode) captureNode.port.onmessage = null;
    stream?.getTracks().forEach(track => track.stop());
    try { source?.disconnect(); captureNode?.disconnect(); gain?.disconnect(); } catch {}
  };
  try {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    if (context.state !== 'running') await context.resume();
    if (context.state !== 'running') throw new Error('Tap to unlock microphone audio');
    let response;
    if (recording) {
      capture = observe(VoiceStreamCapture.fromRecording(recording, callbacks));
      response = await capture.response(abort.signal);
    } else {
      if (!context.audioWorklet || !globalThis.AudioWorkletNode) throw new Error('Streaming microphone capture is unavailable in this browser');
      if (!loaded.has(context)) {
        await context.audioWorklet.addModule(new URL('./vendor/omni/capture-worklet.js', import.meta.url)); loaded.add(context);
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true,
        noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } } });
      if (abort.signal.aborted) throw new DOMException('Stopped', 'AbortError');
      const vad = new VoiceActivity(context.sampleRate);
      const captured = new Promise((resolve, reject) => {
        const commit = async () => {
          if (committing) return;
          committing = true; stopMicrophone();
          if (!capture) return resolve(null); // silence: no model request
          try { resolve(await capture.response(abort.signal)); } catch (error) { reject(error); }
        };
        const cancelled = () => { stopMicrophone(); reject(new DOMException('Stopped', 'AbortError')); };
        abort.signal.addEventListener('abort', cancelled, { once: true });
        installCommit?.(commit);
        stream.getTracks().forEach(track => track.addEventListener('ended', () => {
          if (!committing && !abort.signal.aborted) { stop(); reject(new Error('Microphone disconnected. Your words are kept.')); }
        }, { once: true }));
        source = context.createMediaStreamSource(stream);
        captureNode = new AudioWorkletNode(context, 'voice-capture');
        gain = context.createGain(); gain.gain.value = 0;
        source.connect(captureNode); captureNode.connect(gain); gain.connect(context.destination);
        idleTimer = setTimeout(commit, 8000);
        captureNode.port.onmessage = event => {
          if (committing || abort.signal.aborted) return;
          try {
            const result = vad.push(event.data);
            onLevel?.(result.rms);
            if (!capture && (vad.started || result.samples)) {
              clearTimeout(idleTimer);
              capture = observe(new VoiceStreamCapture(context.sampleRate, { voiceId }, callbacks));
              for (const frame of result.samples ? [result.samples] : vad.parts) capture.push(frame);
              recordingTimer = setTimeout(commit, 26000);
            } else if (capture) capture.push(event.data);
            if (result.samples) void commit();
          } catch (error) { stopMicrophone(); reject(error); }
        };
      });
      response = await Promise.race([captured, failed]);
      if (!response) return { text: '', answered: false, ignoredReason: 'no-speech' };
    }
    await consumeSpeech(response, { player: queue, isCurrent: () => !abort.signal.aborted,
      onEvent(name, data) {
        if (name === 'transcript_final') {
          receiveFinal(data);
          if (handoff) stop();
        } else if (name === 'text') { onSpeaking?.(); answerText += String(data.delta || ''); onText?.(String(data.delta || '')); }
        else if (name === 'done') answered = !data.empty;
      } });
    return { text: final, answered, ignoredReason };
  } catch (error) {
    if (handoff) return { text: final, answered: false, ignoredReason };
    error.finalText = final;
    error.partial = !!answerText || sawAnswer;
    if (error.status === 429 && !error.retryAfterMs) error.retryAfterMs = 30000;
    // Only unfinished recognition can retain a recording for a deliberate retry.
    // Never replay a partial answer or redo ASR after a final transcript exists.
    if (!final) error.recording = capture?.recording();
    throw error;
  } finally {
    stopMicrophone(); stop(); installCommit?.(null);
    signal?.removeEventListener('abort', stop); document.removeEventListener('visibilitychange', hidden);
    // Observe background upload failure even if the user stopped before commit.
    failed.catch(() => {});
  }
}
