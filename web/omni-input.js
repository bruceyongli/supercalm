// Browser/business adapter around Omni's unmodified ASR SDK. Recognition never
// starts a speculative answer. FINAL text enters the same context/confirmation
// harness as typed input; Omni still owns uploads, resampling and reconnection.
import { VoiceActivity } from './vendor/omni/voice-core.mjs';
import { OmniASR } from './vendor/omni/omni-asr.mjs';

const loaded = new WeakSet();
export async function listenOmni({ context, voiceId, signal, onPartial, onFinal,
  onConnection, onLevel, installCommit, recording } = {}) {
  let stream, source, captureNode, gain, asr, ready, final = '', finalDelivered = false,
    recordingTimer, idleTimer, committing = false, queuedSamples = 0;
  let pushes = Promise.resolve();
  const retained = [], rate = recording?.sampleRate || context.sampleRate;
  const abort = new AbortController();
  const stop = () => { abort.abort(); void asr?.stop(); };
  signal?.addEventListener('abort', stop, { once: true });
  const hidden = () => { if (document.hidden) stop(); };
  document.addEventListener('visibilitychange', hidden);
  let failCapture;
  const failed = new Promise((_, reject) => { failCapture = reject; });
  failed.catch(() => {});
  const recognition = () => {
    const value = new OmniASR({ base: 'api/voice/input/sessions', headers: {},
      appId: 'supercalm', language: 'auto', continuous: false, onConnection,
      onTranscript(data) {
        onPartial?.(data.text);
        if (data.confirmedText) {
          final = data.confirmedText;
          if (!finalDelivered) { finalDelivered = true; onFinal?.(final); }
        }
      }, onError: failCapture });
    // Only the application owner identity is added. No credentials, sources,
    // voice selection or second transport implementation enter the shared SDK.
    const start = value.client.start.bind(value.client);
    value.client.start = options => start({ ...options, voiceId });
    return value;
  };
  const push = samples => {
    if (queuedSamples + samples.length > rate * 30) throw Error('Maximum 30-second buffered recording reached');
    // Retain only this bounded short recording for an explicit no-final retry.
    // The shared SDK owns PCM encoding/stateful resampling and upload sequencing.
    const frame = samples.slice(); retained.push(frame); queuedSamples += frame.length;
    pushes = pushes.then(async () => {
      await ready;
      if (abort.signal.aborted) throw new DOMException('Stopped', 'AbortError');
      for (let at = 0; at < frame.length; at += rate) asr.pushFloat(frame.subarray(at, at + rate), rate);
    });
    pushes.catch(failCapture);
  };
  const stopMicrophone = () => {
    clearTimeout(recordingTimer); clearTimeout(idleTimer);
    if (captureNode) captureNode.port.onmessage = null;
    stream?.getTracks().forEach(track => track.stop());
    try { source?.disconnect(); captureNode?.disconnect(); gain?.disconnect(); } catch {}
  };
  const finish = async () => {
    await pushes;
    const done = await asr.finish();
    // done proves recognition completed, even when its commit ACK was lost.
    return { text: done.text, answered: false, ignoredReason: done.text ? '' : 'no-speech' };
  };
  try {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    if (context.state !== 'running') await context.resume();
    if (context.state !== 'running') throw Error('Tap to unlock microphone audio');
    if (recording) {
      asr = recognition(); ready = asr.start(); ready.catch(failCapture);
      for (const frame of recording.frames) push(frame);
      return await Promise.race([finish(), failed]);
    }
    if (!context.audioWorklet || !globalThis.AudioWorkletNode) throw Error('Streaming microphone capture is unavailable in this browser');
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
        if (!asr) return resolve({ text: '', answered: false, ignoredReason: 'no-speech' });
        try { resolve(await finish()); } catch (error) { reject(error); }
      };
      const cancelled = () => { stopMicrophone(); reject(new DOMException('Stopped', 'AbortError')); };
      abort.signal.addEventListener('abort', cancelled, { once: true });
      installCommit?.(commit);
      stream.getTracks().forEach(track => track.addEventListener('ended', () => {
        if (!committing && !abort.signal.aborted) { stop(); reject(Error('Microphone disconnected. Your words are kept.')); }
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
          if (!asr && (vad.started || result.samples)) {
            clearTimeout(idleTimer);
            asr = recognition(); ready = asr.start(); ready.catch(failCapture);
            for (const frame of result.samples ? [result.samples] : vad.parts) push(frame);
            recordingTimer = setTimeout(commit, 26000);
          } else if (asr) push(event.data);
          if (result.samples) void commit();
        } catch (error) { stopMicrophone(); reject(error); }
      };
    });
    return await Promise.race([captured, failed]);
  } catch (error) {
    error.finalText = final; error.partial = false;
    if (error.status === 429 && !error.retryAfterMs) error.retryAfterMs = 30000;
    if (!final && retained.length) error.recording = { frames: retained, sampleRate: rate };
    throw error;
  } finally {
    stopMicrophone(); stop(); installCommit?.(null);
    signal?.removeEventListener('abort', stop); document.removeEventListener('visibilitychange', hidden);
    failed.catch(() => {});
  }
}
