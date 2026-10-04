// Shared TTS playback — the generic audio machinery extracted from voicemode.js so other views
// (story view "listen", later phone.js/voicemode itself) can speak text through the EXISTING
// server endpoints (/api/tts, /api/tts/stream) without duplicating the hard-won iOS handling:
//   - one persistent Audio element, gesture-unlocked via a silent clip (unlockAudio must be
//     called SYNCHRONOUSLY inside the user's tap, before any await);
//   - streamed playback: queue native PCM frames on one gesture-unlocked audio clock;
//     explicit legacy engines retain self-contained clips;
//   - stall timers + absolute caps everywhere (iOS drops 'ended' on blob URLs);
//   - opus when canPlayType allows, else mp3; playbackRate from localStorage.aios_tts_rate.
// Differences from voicemode.js: no overlay/UI coupling (notices are the caller's business) and
// a per-playback HANDLE replaces the module-global stopFlag, so a caller can stop ITS playback
// without a global kill switch. voicemode.js/phone.js are intentionally NOT refactored here.

const SILENT_MP3 = 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYyLjEyLjEwMAAAAAAAAAAAAAAA//OEwAAAAAAAAAAAAEluZm8AAAAPAAAABQAAAqAAbW1tbW1tbW1tbW1tbW1tbW1tbZKSkpKSkpKSkpKSkpKSkpKSkpKStra2tra2tra2tra2tra2tra2trbb29vb29vb29vb29vb29vb29vb2///////////////////////////AAAAAExhdmM2Mi4yOAAAAAAAAAAAAAAAACQEUAAAAAAAAAKgvT/qZwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//NExAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMu//NExFMAAANIAAAAADEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMu//NExKYAAANIAAAAADEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NExKwAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NExKwAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';

let player = null; // the one persistent, gesture-unlocked <audio> (never in the DOM — survives re-renders)
let streamContext = null;
function getStreamContext() {
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Context) throw new Error('native playback unavailable');
  if (!streamContext || streamContext.state === 'closed') streamContext = new Context();
  return streamContext;
}

const RATE_PRESETS = [1, 1.15, 1.25, 1.5, 1.75]; // shared with voicemode (same localStorage key)
function ttsRate() {
  let v = 1;
  try { v = Number(localStorage.getItem('aios_tts_rate') || '1'); } catch {}
  return RATE_PRESETS.includes(v) ? v : 1;
}
export function currentRate() { return ttsRate(); }
// Cycle the speech rate and apply it LIVE to whatever is playing (audio playbackRate is mutable
// mid-clip; speechSynthesis picks it up on the next utterance). Persisted — voicemode shares it.
export function cycleRate() {
  const next = RATE_PRESETS[(RATE_PRESETS.indexOf(ttsRate()) + 1) % RATE_PRESETS.length];
  try { localStorage.setItem('aios_tts_rate', String(next)); } catch {}
  applyRateLive();
  return next;
}
function applyRate(a) {
  if (!a) return;
  try { a.playbackRate = ttsRate(); } catch {}
  try { a.preservesPitch = true; } catch {}
  try { a.webkitPreservesPitch = true; } catch {}
}
function getPlayer() {
  if (!player) player = new Audio();
  applyRate(player);
  return player;
}

// MUST run synchronously inside the tap gesture, before any await — unlocks iOS audio for the
// whole page session (later programmatic play() calls are then allowed however long TTS takes).
export function unlockAudio() {
  try { getStreamContext().resume().catch(() => {}); } catch {}
  try {
    const a = getPlayer();
    a.src = SILENT_MP3;
    const p = a.play();
    if (p && p.then) p.then(() => { try { a.pause(); a.currentTime = 0; } catch {} }).catch(() => {});
  } catch {}
  try { speechSynthesis.getVoices(); const u = new SpeechSynthesisUtterance(''); u.volume = 0; speechSynthesis.speak(u); } catch {}
}

// Per-playback stop handle (replaces voicemode's global stopFlag). One playback at a time is the
// CALLER's contract — stop() pauses the shared element, which resolves the in-flight playUrl.
// Every live handle is also tracked so a view teardown can guarantee nothing keeps narrating: the
// audio is a MODULE SINGLETON (deliberately, so re-renders don't cut it), so the ONLY thing that
// stopped it was the story view's own switch handler. Navigating anywhere else (dashboard, a system
// page, closing the session) orphaned a long report — you'd hear session A while viewing B. The
// registry + stopAllPlayback() make "leaving the view stops the voice" an invariant any view can enforce.
const activeHandles = new Set();
export function newPlayback() {
  const stoppers = new Set();
  const h = { stopped: false, stop() {}, onStop(callback) {
    if (h.stopped) { callback(); return () => {}; }
    stoppers.add(callback); return () => stoppers.delete(callback);
  } };
  h.stop = () => {
    h.stopped = true;
    activeHandles.delete(h);
    for (const callback of stoppers) { try { callback(); } catch {} }
    stoppers.clear();
    try { if (player) player.pause(); } catch {}
    try { speechSynthesis.cancel(); } catch {}
  };
  activeHandles.add(h);
  return h;
}

// Stop EVERY live playback (call on view teardown / navigation). Idempotent.
export function stopAllPlayback() {
  for (const h of [...activeHandles]) { try { h.stop(); } catch {} }
  activeHandles.clear();
  try { if (player) player.pause(); } catch {}
  try { speechSynthesis.cancel(); } catch {}
}

export function preferredTtsFormat() {
  try {
    const a = document.createElement('audio');
    if (a.canPlayType('audio/ogg; codecs="opus"') || a.canPlayType('audio/opus')) return 'opus';
  } catch {}
  return 'mp3';
}
// TTS engines often interpret a dot between digits as a sentence break, producing multi-second gaps
// in versions, dotted dates, decimals, and IP addresses. Spell only those numeric dots as one spoken
// phrase; keep the visible transcript unchanged.
export function textForTts(text) {
  return String(text || '').replace(/(\d)\.(?=\d)/g, '$1 point ').replace(/\s{2,}/g, ' ');
}
const ttsPayload = (text, extra = {}) => ({ text: textForTts(text), response_format: preferredTtsFormat(), ...extra });

// Locate the model's spoken phrase in the unchanged visible report, including numeric-dot speech
// normalization. No punctuation-based sentence guesses and no text-length timing approximation.
export function speechTextRange(source, phrase, from = 0) {
  source = String(source || '');
  const origins = []; let spoken = '';
  for (let at = 0; at < source.length; at++) {
    const part = source[at] === '.' && /\d/.test(source[at - 1] || '') && /\d/.test(source[at + 1] || '') ? ' point ' : source[at];
    for (const char of part.toLowerCase()) {
      if (/\s/.test(char) && (!spoken || spoken.endsWith(' '))) continue;
      spoken += /\s/.test(char) ? ' ' : char; origins.push(at);
    }
  }
  const needle = textForTts(phrase).toLowerCase().trim();
  if (!needle) return null;
  const after = origins.findIndex(at => at >= from);
  if (after < 0) return null;
  const begin = spoken.indexOf(needle, after);
  if (begin < 0) return null;
  return { start: origins[begin], end: origins[begin + needle.length - 1] + 1 };
}

export function splitSentences(text) {
  const source = String(text || '');
  // Punctuation is a sentence boundary only before whitespace/end. This keeps 2026.07.22, v0.3.286,
  // file.js, and 3.14 in a single visual/audio segment.
  const raw = source.match(/[\s\S]*?[.!?]+(?=\s|$)|[\s\S]+$/g) || [source];
  const out = [];
  for (const piece of raw.map((s) => s.trim()).filter(Boolean)) {
    if (out.length && (out[out.length - 1].length < 18 || piece.length < 12)) out[out.length - 1] += ' ' + piece;
    else out.push(piece);
  }
  return out;
}
function base64ToBlob(base64, mediaType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mediaType || 'audio/mpeg' });
}
function parseSseBlock(block) {
  let event = 'message';
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  const data = dataLines.length ? JSON.parse(dataLines.join('\n')) : {};
  return { event, data };
}

// Play one blob URL on the gesture-unlocked element; ALWAYS resolves (ended/error/stop, an iOS
// dropped-'ended' stall timer, and an absolute cap).
function playUrl(url, h) {
  return new Promise((resolve) => {
    if (h.stopped) { try { URL.revokeObjectURL(url); } catch {} return resolve(); }
    let done = false, cap = null, stall = null;
    const fin = () => {
      if (done) return;
      done = true;
      if (cap) clearTimeout(cap);
      if (stall) clearTimeout(stall);
      try { URL.revokeObjectURL(url); } catch {}
      resolve();
    };
    const arm = (ms) => { if (stall) clearTimeout(stall); stall = setTimeout(fin, ms); };
    cap = setTimeout(fin, 60000);
    const a = getPlayer();
    a.onended = a.onerror = fin;
    a.onpause = () => { if (h.stopped) fin(); };
    a.onplaying = a.ontimeupdate = () => arm(3500);
    a.src = url;
    try { a.currentTime = 0; } catch {}
    applyRate(a);
    a.play().then(() => arm(5000)).catch(fin);
  });
}

// Streamed: play native frames as they arrive, following Omni's phrase metadata and cadence.
// The absolute cap SCALES with the text (~2min of audio per 1800 chars at 1×) and, once any chunk
// has PLAYED, firing it resolves instead of rejecting — a rejection here makes the caller
// re-synthesize the same part and replay it from the top (the "loops back to the beginning" bug).
function speakStream(text, h, extra = {}, onSlow, onSegment, onPartial) {
  return new Promise((resolve, reject) => {
    if (!text || h.stopped) return resolve();
    const ctrl = new AbortController();
    const urls = [];
    const seenChunkIds = new Set();
    let lastUnindexedText = '';
    let readingDone = false, playing = false, finished = false, played = 0;
    let pcmQueue = null, native = false, nativeDone = false, unregisterStop = () => {};
    const capMs = Math.max(90000, 20000 + (text.length * 130) / ttsRate());
    const cap = setTimeout(() => finish(played ? undefined : new Error('tts stream timeout')), capMs);
    const slow = onSlow ? setTimeout(() => { if (!played && !finished) { try { onSlow(); } catch {} } }, 4500) : null; // still no audio → "spark is slow"
    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(cap);
      if (slow) clearTimeout(slow);
      unregisterStop(); pcmQueue?.stop(); h.setRate = null;
      try { ctrl.abort(); } catch {}
      for (const item of urls.splice(0)) { try { URL.revokeObjectURL(item.url); } catch {} }
      err ? reject(err) : resolve();
    };
    unregisterStop = h.onStop?.(() => finish()) || (() => {});
    const pump = async () => {
      if (playing || finished) return;
      playing = true;
      while (urls.length && !h.stopped && !finished) {
        const item = urls.shift();
        played += 1;
        try { onSegment?.({ text: item.text || '', index: Number.isFinite(item.index) ? item.index : played - 1 }); } catch {}
        await playUrl(item.url, h);
      }
      playing = false;
      if (h.stopped) return finish();
      if (readingDone && !urls.length) return played ? finish() : finish(new Error('no audio'));
    };
    (async () => {
      try {
        const r = await fetch('api/tts/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(ttsPayload(text, extra)),
          signal: ctrl.signal,
        });
        if (!r.ok || !r.body?.getReader) throw new Error('tts stream ' + r.status);
        if (!String(r.headers.get('content-type')).startsWith('text/event-stream')) throw new Error('invalid tts stream');
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep = buffer.indexOf('\n\n');
          while (sep !== -1) {
            const block = buffer.slice(0, sep).trim();
            buffer = buffer.slice(sep + 2);
            if (block) {
              const { event, data } = parseSseBlock(block);
              if (event === 'metadata' && data.transport === 'native-pcm-frames') native = true;
              else if (event === 'audio') {
                native = true;
                if (!pcmQueue) {
                  const { createPcmQueue } = await import('./voice-stream.js');
                  const context = getStreamContext(); await context.resume();
                  if (finished || h.stopped) return;
                  if (context.state !== 'running') throw new Error('native playback unavailable');
                  pcmQueue = createPcmQueue(context, { rate: ttsRate(), onSegment,
                    onStarted: () => { played = 1; }, onEmpty: () => { if (readingDone) finish(); } });
                  h.setRate = value => pcmQueue.setRate(value);
                }
                pcmQueue.push(data);
              } else if (event === 'chunk' && data.audio_base64) {
                if (native) throw new Error('speech transport changed mid-stream');
                const index = Number(data.index);
                const chunkText = String(data.text || '').replace(/\s+/g, ' ').trim();
                // A reconnecting/upstream streaming synthesizer can replay its first completed
                // chunks. Their indices are transport identities: enqueue each one exactly once or
                // the listener hears the opening sentences repeated even though the transcript is
                // correct. Older streams without indices get a conservative consecutive-text guard.
                if (Number.isFinite(index)) {
                  if (seenChunkIds.has(index)) {
                    sep = buffer.indexOf('\n\n');
                    continue;
                  }
                  seenChunkIds.add(index);
                } else if (chunkText && chunkText === lastUnindexedText) {
                  sep = buffer.indexOf('\n\n');
                  continue;
                }
                lastUnindexedText = Number.isFinite(index) ? '' : chunkText;
                urls.push({
                  url: URL.createObjectURL(base64ToBlob(data.audio_base64, data.media_type)),
                  text: chunkText,
                  index,
                });
                pump();
              } else if (event === 'done') {
                nativeDone = true;
                readingDone = true;
                if (pcmQueue) pcmQueue.seal(); else pump();
              } else if (event === 'error') {
                throw new Error(data.detail || 'tts stream error');
              }
            }
            sep = buffer.indexOf('\n\n');
          }
        }
        if (native && !nativeDone) throw new Error('native speech ended before completion');
        readingDone = true;
        if (pcmQueue) pcmQueue.seal(); else pump();
      } catch (e) {
        if (!finished && !h.stopped) {
          if (played) { try { onPartial?.(e); } catch {} }
          finish(played ? undefined : e);
        }
      }
    })();
  });
}

// Single-shot /api/tts (server falls back Spark → provider → macOS-say internally).
// Same anti-replay rule as the stream: the cap scales with the text and never REJECTS after audio
// has started — rejecting mid-play would cascade into speechSynthesis re-reading the whole part.
function speakSingle(text, h, extra = {}, onSlow, onSegment, preparedAudio = null, preparedSegments = []) {
  return new Promise((resolve, reject) => {
    if (!text || h.stopped) return resolve();
    let done = false, cap = null, stall = null, playedSome = false, shownSegment = -1, audioUrl = null;
    const segments = preparedSegments.length ? preparedSegments : [{ text, start: 0, index: 0 }];
    const ctrl = new AbortController();
    const slow = onSlow ? setTimeout(() => { if (!playedSome && !done) { try { onSlow(); } catch {} } }, 4500) : null;
    const finish = (err) => {
      if (done) return;
      done = true;
      if (cap) clearTimeout(cap);
      if (stall) clearTimeout(stall);
      if (slow) clearTimeout(slow);
      if (audioUrl) { try { URL.revokeObjectURL(audioUrl); } catch {} audioUrl = null; }
      try { ctrl.abort(); } catch {}
      try { if (player) { player.onended = player.onerror = player.ontimeupdate = player.onplaying = player.onpause = null; player.pause(); } } catch {}
      err && !h.stopped && !playedSome ? reject(err) : resolve();
    };
    const armStall = (ms) => { if (stall) clearTimeout(stall); stall = setTimeout(finish, ms); };
    // Single-shot audio stays one uninterrupted file. Advance only the visual reading marker from
    // playback time so a long live answer remains easy to follow without chopping its audio up.
    const showProgress = (audio) => {
      let index = 0;
      for (let at = 1; at < segments.length; at++) if (audio.currentTime >= segments[at].start) index = at;
      if (index === shownSegment) return;
      shownSegment = index;
      try { onSegment?.({ text: segments[index].text || text, index, total: segments.length }); } catch {}
    };
    cap = setTimeout(() => finish(new Error('tts timeout')), 12000 + (text.length * 130) / ttsRate());
    (async () => {
      try {
        let blob = preparedAudio;
        if (!blob) {
          const r = await fetch('api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ttsPayload(text, extra)), signal: ctrl.signal });
          if (!r.ok) throw new Error('tts ' + r.status);
          blob = await r.blob();
        }
        if (done || h.stopped) return finish();
        const url = URL.createObjectURL(blob);
        audioUrl = url;
        const a = getPlayer();
        a.onended = () => { try { URL.revokeObjectURL(url); } catch {} finish(); };
        a.onerror = () => { try { URL.revokeObjectURL(url); } catch {} finish(new Error('audio playback failed')); };
        a.onplaying = () => {
          playedSome = true;
          showProgress(a);
          armStall(3500);
        };
        a.ontimeupdate = () => {
          playedSome = true;
          showProgress(a);
          armStall(3500);
        };
        a.onpause = () => { if (h.stopped) finish(); };
        a.src = url;
        try { a.currentTime = 0; } catch {}
        applyRate(a);
        await a.play();
        armStall(5000);
      } catch (e) {
        if (done) return;
        finish(e);
      }
    })();
  });
}

// On-device speechSynthesis — the last-resort fallback (and the user's explicit choice when
// localStorage.aios_tts === 'browser'). Honors the voice picked in the voice-mode picker.
function chosenVoice() {
  try {
    const id = localStorage.getItem('aios_tts_voice');
    if (!id) return null;
    const vs = speechSynthesis.getVoices() || [];
    return vs.find((v) => v.voiceURI === id) || vs.find((v) => v.name === id) || null;
  } catch { return null; }
}
function speakBrowser(text, h, onSegment, continuous = false) {
  return new Promise((resolve) => {
    if (!text || h.stopped || typeof speechSynthesis === 'undefined') return resolve();
    let done = false, cap = null, poll = null, started = false;
    const fin = () => { if (done) return; done = true; if (cap) clearTimeout(cap); if (poll) clearInterval(poll); resolve(); };
    try {
      speechSynthesis.cancel();
      const chunks = continuous ? [text] : text.length > 240 ? splitSentences(text) : [text];
      const picked = chosenVoice();
      chunks.forEach((p, i) => {
        const u = new SpeechSynthesisUtterance(textForTts(p));
        if (picked) u.voice = picked;
        u.rate = ttsRate();
        u.onstart = () => { try { onSegment?.({ text: p, index: i, total: chunks.length }); } catch {} };
        if (i === chunks.length - 1) u.onend = u.onerror = fin;
        speechSynthesis.speak(u);
      });
      poll = setInterval(() => {
        if (done) return;
        if (h.stopped) return fin();
        if (speechSynthesis.speaking || speechSynthesis.pending) started = true;
        else if (started) fin();
      }, 250);
      cap = setTimeout(fin, Math.min(60000, 5000 + (text.length * 110) / ttsRate()));
    } catch { fin(); }
  });
}

// The one entry point: speak `text` on playback handle `h`, honoring the user's engine pref and
// falling through every layer (stream → single-shot → device voice) so it never dead-ends.
// `ttsExtra` = optional server hints ({engine, voice, instruct}) passed through to /api/tts*.
// Streaming is Spark-only (/api/tts/stream 409s on provider/local backends per the system's voice
// config) — after the first stream failure we go straight to single-shot for the rest of this page
// session instead of burning a failed round-trip per part on no-Spark installs.
let streamUnavailable = false;
// Optional callbacks let a caller show its own UI without coupling this module to any:
//   onSlow()     — the neural path has produced no audio after ~4.5s (e.g. "Spark is slow").
//   onFallback() — neural failed and we're speaking with the on-device voice instead.
//   onSegment()  — a sentence/audio segment has started, for a current-reading indicator.
export async function speakSmart(text, h, { ttsExtra = {}, onSlow, onFallback, onPartial, onSegment, continuous = false, preparedAudio = null, preparedSegments = [] } = {}) {
  if (!text || h.stopped) return;
  let mode = 'neural';
  try { mode = localStorage.getItem('aios_tts') || 'neural'; } catch {}
  if (mode === 'browser') return speakBrowser(text, h, onSegment, continuous);
  try {
    if (preparedAudio) return await speakSingle(text, h, ttsExtra, onSlow, onSegment, preparedAudio, preparedSegments);
    if (!streamUnavailable) {
      return await speakStream(text, h, ttsExtra, onSlow, onSegment, onPartial).catch((e) => {
        // 409 = the configured backend can't stream (a config state — remember it until reload);
        // anything else is a transient Spark/network failure — retry streaming on the next part.
        if (/\b409\b|native playback unavailable/.test(String(e?.message || ''))) streamUnavailable = true;
        if (h.stopped) return;
        return speakSingle(text, h, ttsExtra, onSlow, onSegment);
      });
    }
    return await speakSingle(text, h, ttsExtra, onSlow, onSegment);
  } catch {
    if (h.stopped) return;
    try { onFallback?.(); } catch {}
    return speakBrowser(text, h, onSegment, continuous);
  }
}

// Re-apply the current localStorage rate to the live shared element (for a rate control that should
// take effect mid-utterance). cycleRate() already does this when cycling; this is for a direct set.
export function applyRateLive() {
  if (player) applyRate(player);
  for (const handle of activeHandles) handle.setRate?.(ttsRate());
}
