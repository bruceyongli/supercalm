// Thin UI adapter over Omni's UNMODIFIED paired output package. No local PCM
// decoder, buffer policy, segmentation, pitch/speed or silence corrections.
import { OmniAudioPlayer, decodeSpeechPCM } from './vendor/omni/omni-speech.mjs';

export function nativePcmSamples(encoded) {
  return decodeSpeechPCM(encoded, { createBuffer(_channels, length) {
    const samples = new Float32Array(length);
    return { getChannelData: () => samples };
  } }).getChannelData(0);
}

export function createPcmQueue(context, { voice, onSegment, onStarted, onEmpty } = {}) {
  let player, stopped = false, sealed = false;
  const seen = new Set(), markers = new Set();
  const announce = marker => {
    if (stopped || marker.announced) return;
    // Reading highlights follow the audio clock, including iOS suspension.
    if (context.state !== 'running' || context.currentTime < marker.when) {
      marker.timer = setTimeout(() => announce(marker), 30); return;
    }
    marker.announced = true; markers.delete(marker); onStarted?.();
    if (marker.data.text) onSegment?.({ text: marker.data.text,
      index: marker.data.segmentIndex ?? marker.data.phrase_index ?? marker.data.index });
  };
  const queue = {
    push(data) {
      if (stopped || sealed) throw new Error('Speech queue is closed');
      if (seen.has(data.index)) return; // a resumed journal must not replay heard audio
      player ||= new OmniAudioPlayer(context, { voice: voice || data.voice });
      const when = player.enqueue(data);
      seen.add(data.index);
      const marker = { data, when, announced: false }; markers.add(marker);
      marker.timer = setTimeout(() => announce(marker), Math.max(0, (when - context.currentTime) * 1000));
    },
    seal() {
      if (sealed || stopped) return;
      sealed = true;
      (player?.drained() || Promise.resolve()).then(() => {
        if (stopped) return;
        for (const marker of markers) { clearTimeout(marker.timer); announce(marker); }
        onEmpty?.();
      });
    },
    setRate() {}, // native playback is fixed at 1x by Omni
    drained() { return player?.drained() || Promise.resolve(); },
    stop() {
      stopped = true; player?.stop();
      for (const marker of markers) clearTimeout(marker.timer);
      markers.clear();
    },
  };
  queue.enqueue = queue.push;
  return queue;
}
