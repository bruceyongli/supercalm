import { api, createLiveSpeechRecognizer, rememberSpeechLanguage, preferredSttLangs } from './common.js';
import { unlockAudio as unlockPlayer, voiceAudioContext, newPlayback, speechTextRange, stopAllPlayback, speakSmart, speakConversation, applyRateLive } from './tts-player.js';
import { extractVoiceInterruption, isClearVoiceInterruption } from './voice-interruption.js';
import { VOICE_CAPTURE_DEFAULTS, voiceTranscriptDisposition } from './voice-input.js';
import { voiceSpeakerControl } from './voice-controls.js';

// Hands-free voice concierge loop:
//   speak (TTS) -> [listen with VAD -> STT -> /turn]  OR  [/continue] -> speak -> ...
// until the server says done or the user taps Stop / says "stop".
// TTS synthesis + playback is the SHARED tts-player.js stack (one stack for story-view + concierge +
// phone); this module owns the concierge LOOP, the overlay UI, VAD/STT, and the device-voice picker.
let active = false,
  stopFlag = false,
  voiceId = null,
  selectedVoice = 'Ryan',
  handle = null, // current tts-player playback handle (for stop)
  requestInterrupt = null,
  ui = null;
let recoveryResume = null;
let pendingDismiss = null, controlAbort = null, captureAbort = null;
let visibilityPaused = false;
globalThis.document?.addEventListener('visibilitychange', () => {
  if (!document.hidden || !active) return;
  visibilityPaused = true; captureAbort?.abort();
  try { handle?.stop(); stopAllPlayback(); } catch {}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TTS_RATE_KEY = 'aios_tts_rate';
const TTS_RATE_PRESETS = [1, 1.15, 1.25, 1.5, 1.75];

let vadCtx = null; // ONE gesture-unlocked AudioContext for every turn's VAD analyser — a per-turn
// context created after the first turn is outside any gesture, so iOS starts it 'suspended': the
// analyser reads flat, "silence" never ends, and recording was force-cut at the 8s no-speech grace.
// Unlock iOS audio (the shared player) + the VAD AudioContext — MUST run synchronously in the tap.
function unlockAudio() {
  unlockPlayer(); // shared <audio> gesture-unlock + speechSynthesis warm (tts-player)
  try {
    vadCtx = vadCtx || voiceAudioContext();
    if (vadCtx.state !== 'running') vadCtx.resume().catch(() => {});
  } catch {}
}

// Voice updates calls this directly inside the operator's enable tap. That one gesture unlocks audio,
// starts the notification permission prompt in parallel, and obtains microphone permission before a
// future Needs You update arrives. The stream is released immediately; the real conversation opens a
// fresh stream only while listening.
export async function prepareVoiceMode({ requestMic = true } = {}) {
  unlockAudio();
  if (!requestMic) return { audio: true, mic: null };
  try {
    const stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints());
    stream.getTracks().forEach((track) => track.stop());
    return { audio: true, mic: true };
  } catch (error) {
    return { audio: true, mic: false, error: error?.name || error?.message || 'microphone unavailable' };
  }
}

export function isVoiceModeActive() {
  return active;
}

export function stopVoiceMode() {
  if (!active) return;
  end('external');
}

export async function prepareVoiceUpdate({ focusSessionId, reportId } = {}) {
  const prepared = await post('api/voice/prepare', { focusSessionId, reportId }, 90000);
  const response = await fetch(prepared.audioUrl, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('The voice update changed before it was ready');
  const audioBlob = await response.blob();
  if (!audioBlob.size) throw new Error('The prepared voice update has no audio');
  return { ...prepared, audioBlob };
}

export async function startVoiceMode({ focusSessionId = null, source = 'manual', preparedUpdate = null, reportTs = null } = {}) {
  if (active) return;
  active = true;
  stopFlag = false;
  pendingDismiss = null;
  visibilityPaused = false;
  unlockAudio(); // MUST run synchronously in the tap gesture, before any await, to unlock iOS audio
  const onTheGo = String(source).startsWith('on-the-go');
  if (!onTheGo) ui = buildOverlay({ onTheGo: true });
  try {
    if (onTheGo && !preparedUpdate) preparedUpdate = await prepareVoiceUpdate({ focusSessionId });
    let state = await post('api/voice/start', { focusSessionId, source, reportTs, realtime: ttsMode() !== 'browser', preparationId: preparedUpdate?.preparationId });
    voiceId = state.voiceId;
    selectedVoice = state.voice || 'Ryan';
    const streamInputEnabled = state.streamInput === true;
    if (stopFlag) return;
    if (onTheGo) ui = buildOverlay({ onTheGo, initialText: state.say });
    let lastSpoken = '';
    while (!stopFlag) {
      try {
        if (visibilityPaused) {
          if (!await waitVoiceRetry('Voice paused while the app was hidden. Your report and response are kept.', { label: 'Resume' })) break;
        }
        if (pendingDismiss) {
          try { await post('api/voice/dismiss', { voiceId, ...pendingDismiss }); }
          catch (error) { if (error.code !== 'voice_report_changed') throw error; }
          // A late click must never dismiss a different report. Reconcile the displayed item rather
          // than endlessly retrying the stale target or advancing a second time.
          pendingDismiss = null; clearTtsNotice();
          state = await post('api/voice/continue', { voiceId });
          continue;
        }
        if (state.voice && state.voice !== selectedVoice) { selectedVoice = state.voice; renderVoiceControls(); }
        if (state.current) updateProgress(state.current);
        if (state.delivery) updateDelivery(state.delivery, state.sentCount);
        if (state.acceptedText) {
          setHeard(state.acceptedText);
          if (ui?.spokenLabel) ui.spokenLabel.textContent = state.grounded ? 'SOURCE-GROUNDED RESPONSE' : 'ASSISTANT RESPONSE';
        }
        if (state.ignored) markIgnoredSpeech(state.ignoredReason);
        if (state.done && ui) ui.bar.style.width = '100%';
        // Ignored nearby speech and silent windows are intentionally silent responses: keep listening
        // without erasing/re-reading the project brief or pretending a conversational turn happened.
        let interruption = null;
        if (!state.ignored || state.say) {
          setState('speaking', state.say);
          lastSpoken = state.say || lastSpoken;
          const preparedAudio = preparedUpdate?.say === state.say ? preparedUpdate.audioBlob : null;
          const preparedSegments = preparedAudio ? preparedUpdate.segments || [] : [];
          const preparedNative = !!(preparedAudio && preparedUpdate?.nativeSpeech);
          preparedUpdate = null; // this exact opening is played once; never reuse it for later replies
          interruption = await speak(state.say, { allowInterruption: !state.done && !!state.current, preparedAudio, preparedSegments, preparedNative,
            realtime: state.realtimeOpening || state.realtimeQuestion ? { opening: !!state.realtimeOpening, userText: state.realtimeQuestion || '' } : null });
          lastSpoken = ui?.spokenText || state.say || lastSpoken;
        }
        if (state.done || stopFlag) break;
        if (visibilityPaused) continue;
        if (pendingDismiss) continue;
        const completedControl = state.listen === false && ['sent', 'skipped'].includes(state.delivery?.status);
        if (interruption?.failed && !completedControl) {
          const resume = await waitVoiceRetry('This report was interrupted. Your report and words are kept. Ask a follow-up to continue the conversation, or dismiss this report.', { label: 'Ask a follow-up', retryAfterMs: interruption.error?.retryAfterMs || interruption.error?.retry?.retry_after_ms });
          if (pendingDismiss) continue;
          if (!resume) break;
          state = { ...state, say: '', listen: true, ignored: true, realtimeOpening: false, realtimeQuestion: '' };
          continue;
        }
        if (interruption?.text) {
          const disposition = voiceTranscriptDisposition(interruption.text, { spoken: lastSpoken });
          if (!disposition.accepted) {
            markIgnoredSpeech(disposition.reason);
            await keepVoiceAlive(disposition.reason);
            state = { ...state, say: '', ignored: true, ignoredReason: disposition.reason, listen: true };
            continue;
          }
          setHeard(disposition.text);
          setState('thinking');
          state = await post('api/voice/turn', { voiceId, userText: disposition.text, realtime: ttsMode() !== 'browser' });
        } else if (state.listen || interruption?.tap) {
          setState('listening');
          let text = '';
          let live = null;
          if (streamInputEnabled && ttsMode() !== 'browser') {
            let recording = null, result;
            for (;;) {
              const ctrl = new AbortController(); captureAbort = ctrl;
              let started = false, interrupted = false, barge = null, bargeText = '';
              try {
                const { listenOmni } = await import('./omni-input.js');
                result = await listenOmni({ context: voiceAudioContext(), voiceId, voice: selectedVoice,
                  signal: ctrl.signal, recording,
                  onPartial: value => { if (value) { setHeard(value); if (ui?.heardLabel) ui.heardLabel.textContent = 'YOUR RESPONSE · TRANSCRIBING'; } },
                  onFinal: setHeard,
                  onText: appendSpokenText, onSegment: focusSpokenSegment,
                  onLevel: rms => { if (ui?.orb) ui.orb.style.transform = `scale(${(1 + Math.min(rms * 4, 1)).toFixed(2)})`; },
                  onConnection: status => {
                    if (status.state === 'reconnecting') showTtsNotice('Reconnecting to the same recording. Your words are kept; nothing is being resent as a new request.', { kind: 'reconnecting' });
                    else if (status.state === 'connected') clearTtsNotice();
                  },
                  installCommit: commit => {
                    requestInterrupt = commit;
                    if (ui?.interrupt) { ui.interrupt.hidden = !commit; ui.interrupt.textContent = commit ? 'Send now' : 'Speak now'; }
                  },
                  onSpeaking: () => {
                    if (started) return; started = true;
                    setState('speaking', ''); clearTtsNotice();
                    if (ui) { ui.nativeSpeech = true; renderVoiceControls(); }
                    requestInterrupt = () => { interrupted = true; ctrl.abort(); };
                    if (ui?.interrupt) { ui.interrupt.hidden = false; ui.interrupt.textContent = 'Speak now'; }
                    barge = createLiveSpeechRecognizer({ onUpdate: heard => {
                      if (!isClearVoiceInterruption(heard, ui?.spokenText || '')) return;
                      bargeText = extractVoiceInterruption(heard, ui?.spokenText || '') || heard;
                      interrupted = true; ctrl.abort();
                    } });
                    barge.start();
                  },
                });
                break;
              } catch (error) {
                if (stopFlag || pendingDismiss) break;
                if (interrupted) { result = { text: bargeText }; break; }
                const message = error.partial
                  ? 'The reply was interrupted. Your response is kept; ask a follow-up to continue. Nothing was sent.'
                  : 'Voice connection paused. Your words are kept. Retry when ready; nothing was sent.';
                if (!await waitVoiceRetry(message, { label: error.partial ? 'Ask a follow-up' : 'Retry', retryAfterMs: error.retry?.retry_after_ms || error.retryAfterMs })) break;
                if (pendingDismiss || stopFlag) break;
                if (error.finalText && !error.partial) { result = { text: error.finalText }; break; }
                recording = error.partial ? null : error.recording;
                setState('listening');
              } finally {
                barge?.abort();
                if (captureAbort === ctrl) captureAbort = null;
                requestInterrupt = null;
                if (ui?.interrupt) ui.interrupt.hidden = true;
                if (ui?.orb) ui.orb.style.transform = 'scale(1)';
              }
            }
            if (stopFlag) break;
            if (pendingDismiss) continue;
            if (result?.answered) {
              lastSpoken = ui?.spokenText || lastSpoken;
              state = { ...state, say: '', ignored: true, listen: true, realtimeOpening: false, realtimeQuestion: '' };
              continue; // the native answer was already heard; never generate it twice
            }
            text = result?.ignoredReason ? '' : result?.text || '';
          } else {
          try {
            live = createLiveSpeechRecognizer({
              onUpdate: (heard) => {
                if (heard) setHeard(heard);
              },
            });
            live.start();
            const blob = await recordUntilSilence();
            if (stopFlag) break;
            if (pendingDismiss) continue;
            live.stop();
            setState('thinking');
            // Exact assistant settings do not need a second, potentially stalled Whisper round trip.
            const heard = live.getText();
            text = voiceSpeakerControl(heard) ? heard : (await transcribe(blob, state.current?.tool, state.current?.sessionId)) || heard;
            if (pendingDismiss) continue;
          } catch (e) {
            live?.abort(); // a paused permission/device failure must not keep hearing nearby people
            if (pendingDismiss) continue;
            // Permission/device failures need a deliberate retry, not empty turns or an auto-hangup.
            if (/NotAllowed|PermissionDenied|NotFound|NotReadable|Security/i.test(e?.name || '')) {
              const retry = await waitVoiceRetry('Microphone unavailable. Check microphone access, then retry. The conversation is still open.');
              if (pendingDismiss) continue;
              if (!retry) break;
              state = { ...state, say: '', ignored: true, listen: true, realtimeOpening: false, realtimeQuestion: '' };
              continue;
            }
          } finally {
            live?.abort();
          }
          }
          const disposition = voiceTranscriptDisposition(text, { spoken: lastSpoken });
          if (!disposition.accepted) {
            markIgnoredSpeech(disposition.reason);
            await keepVoiceAlive(disposition.reason);
            state = { ...state, say: '', ignored: true, ignoredReason: disposition.reason, listen: true };
            continue;
          }
          setHeard(disposition.text);
          state = await post('api/voice/turn', { voiceId, userText: disposition.text, realtime: ttsMode() !== 'browser' });
        } else {
          setState('thinking');
          state = await post('api/voice/continue', { voiceId });
        }
      } catch (error) {
        if (pendingDismiss && !stopFlag) continue;
        throw error;
      }
    }
  } catch (e) {
    if (stopFlag) return;
    if (onTheGo && !ui) throw e;
    // An unexpected/startup failure must not erase the report or operator's last words. Keep the
    // overlay until the operator ends it; never replay an unknown turn just to restart the loop.
    setState('paused');
    showTtsNotice('Voice connection stopped: ' + (e.message || e) + '. Your report and response are kept here. End and reopen the assistant to reconnect.', { offerDevice: false });
    if (ui?.interrupt) ui.interrupt.hidden = true;
    await new Promise(resolve => { recoveryResume = resolve; });
    if (pendingDismiss && !stopFlag) {
      try { await post('api/voice/dismiss', { voiceId, ...pendingDismiss }); }
      catch (error) { if (error.code !== 'voice_report_changed') throw error; }
      pendingDismiss = null;
    }
  } finally {
    end('complete');
  }
}

async function keepVoiceAlive(reason = '') {
  if (!voiceId || stopFlag) return;
  await post('api/voice/keepalive', { voiceId, reason }, 5000).catch(() => {});
  await sleep(250); // avoid a hot retry loop when MediaRecorder is present but unusable
}

async function post(path, body, ms = 30000) {
  const control = /api\/voice\/(turn|continue|dismiss)$/.test(path);
  const requestBody = control ? { ...body, requestId: crypto.randomUUID() } : body;
  const busyUntil = Date.now() + 3000;
  for (;;) {
    const ctrl = new AbortController();
    if (control) controlAbort = ctrl;
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      return await api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestBody), signal: ctrl.signal });
    } catch (error) {
      if (stopFlag || !control || error.code === 'voice_report_changed' || (pendingDismiss && !path.endsWith('/dismiss'))) throw error;
      // Barge-in can arrive before cancellation releases the previous stream. This 409 means the
      // turn was NOT processed, so a short control-only wait is safe; never retry the model stream.
      if (error.status === 409 && error.message === 'turn already in flight' && Date.now() < busyUntil) {
        await sleep(150); continue;
      }
      const message = error.status === 404
        ? 'The voice connection expired. Your report and words are kept here. End and reopen the assistant to reconnect.'
        : 'Connection interrupted. Your report and response are kept. Retry to continue; nothing will be sent twice.';
      if (!await waitVoiceRetry(message, { retry: error.status !== 404 })) throw error;
      // The SAME request id replays its acknowledged result, including a successful delivery whose
      // HTTP response was lost. A manual retry cannot double-send or skip a second project.
    } finally { clearTimeout(t); if (controlAbort === ctrl) controlAbort = null; }
  }
}

function waitVoiceRetry(message, { retry = true, label = 'Retry', retryAfterMs = 0 } = {}) {
  if (stopFlag || !ui) return Promise.resolve(false);
  setState('paused');
  showTtsNotice(message, { offerDevice: false });
  const readyAt = Date.now() + Math.min(30000, Math.max(0, Number(retryAfterMs) || 0));
  return new Promise(resolve => {
    recoveryResume = resolve;
    if (!retry) { requestInterrupt = null; ui.interrupt.hidden = true; return; }
    requestInterrupt = () => {
      if (Date.now() < readyAt || document.hidden) {
        showTtsNotice(document.hidden ? message : `Voice is busy. Retry in ${Math.ceil((readyAt - Date.now()) / 1000)} seconds. Your words are kept.`, { offerDevice: false });
        return;
      }
      visibilityPaused = false;
      recoveryResume = null; requestInterrupt = null;
      if (ui?.interrupt) { ui.interrupt.hidden = true; ui.interrupt.textContent = 'Speak now'; }
      clearTtsNotice(); resolve(true);
    };
    ui.interrupt.textContent = label; ui.interrupt.hidden = false;
  });
}

function end(reason = 'complete') {
  const wasActive = active;
  stopFlag = true;
  active = false;
  controlAbort?.abort(); captureAbort?.abort(); pendingDismiss = null;
  recoveryResume?.(false); recoveryResume = null;
  if (voiceId) post('api/voice/stop', { voiceId }).catch(() => {});
  voiceId = null;
  requestInterrupt = null;
  try { handle?.stop(); } catch {}
  try { stopAllPlayback(); } catch {} // halt any tts-player playback (belt for the shared element)
  try { closePreviewPanel(); } catch {} // clears the poll timer; the panel DOM leaves with the root
  if (ui) { ui.root.remove(); ui = null; }
  if (wasActive) window.dispatchEvent(new CustomEvent('aios:voice-mode-end', { detail: { reason } }));
}

// ---- TTS: two modes ----
// 'neural' (DEFAULT): Spark's promoted native Qwen BF16 stream. Start playing as frames arrive;
//   the model/gateway supplies phrase boundaries, not client-side punctuation guesses.
// 'browser': on-device speechSynthesis — instant, lower quality, no server round-trip.
function ttsMode() {
  try { return localStorage.getItem('aios_tts') || 'neural'; } catch { return 'neural'; }
}
function setTtsMode(mode) {
  try { localStorage.setItem('aios_tts', mode === 'browser' ? 'browser' : 'neural'); } catch {}
  renderVoiceControls();
}
function ttsRate() {
  let value = 1;
  try { value = Number(localStorage.getItem(TTS_RATE_KEY) || '1'); } catch {}
  return TTS_RATE_PRESETS.includes(value) ? value : 1;
}
function setTtsRate(rate) {
  const value = TTS_RATE_PRESETS.includes(Number(rate)) ? Number(rate) : 1;
  try { localStorage.setItem(TTS_RATE_KEY, String(value)); } catch {}
  applyRateLive(); // apply to the shared player mid-utterance (tts-player)
  renderVoiceControls();
}
function showTtsNotice(message, { offerDevice = false, kind = 'info' } = {}) {
  if (!ui?.ttsNotice) return;
  ui.ttsNotice.hidden = false;
  ui.ttsNotice.textContent = message;
  ui.ttsNotice.dataset.kind = kind;
  if (ui.deviceVoice) ui.deviceVoice.hidden = !offerDevice;
}
function clearTtsNotice() {
  if (!ui?.ttsNotice) return;
  ui.ttsNotice.hidden = true;
  ui.ttsNotice.textContent = '';
  if (ui.deviceVoice) ui.deviceVoice.hidden = true;
}
function renderVoiceControls() {
  if (!ui?.speed) return;
  const natural = ui.nativeSpeech && ttsMode() !== 'browser';
  const rate = natural ? 1 : ttsRate();
  ui.speed.innerHTML = (natural ? [1] : TTS_RATE_PRESETS).map((r) => `<button class="vm-speed-btn ${r === rate ? 'on' : ''}" data-rate="${r}" type="button"${natural ? ' disabled' : ''}>${natural ? 'Natural speed' : r === 1 ? '1x' : r + 'x'}</button>`).join('');
  ui.speed.querySelectorAll('[data-rate]').forEach((btn) => {
    btn.onclick = () => setTtsRate(Number(btn.dataset.rate));
  });
  if (ui.mode) ui.mode.textContent = ttsMode() === 'browser' ? 'Device voice' : `Omni voice · ${selectedVoice}`;
  if (ui.deviceVoice) ui.deviceVoice.textContent = ttsMode() === 'browser' ? 'Use Spark voice' : 'Use device voice';
}
// Speak one line through the SHARED tts-player stack (stream → single → device voice), honoring the
// user's engine pref (aios_tts). The concierge-specific overlay notices ride on tts-player's callbacks.
async function speak(text, { allowInterruption = false, preparedAudio = null, preparedSegments = [], preparedNative = false, realtime = null } = {}) {
  if ((!text && !realtime) || stopFlag) return;
  if (ttsMode() === 'browser') showTtsNotice('Using your device voice. Switch back to Spark Qwen when the network is better.', { offerDevice: true });
  else clearTtsNotice();
  handle = newPlayback();
  let live = null;
  let accepted = null;
  let capturingSpeech = false;
  let pendingSpeech = '';
  let speechTimer = null;
  let partialFailure = null;
  let resolveInterruption;
  const interruption = new Promise((resolve) => { resolveInterruption = resolve; });
  const haltPlayback = () => {
    try { handle?.stop(); } catch {}
    try { stopAllPlayback(); } catch {}
  };
  const accept = (result) => {
    if (accepted || stopFlag) return;
    accepted = result;
    if (speechTimer) clearTimeout(speechTimer);
    haltPlayback();
    resolveInterruption(result);
  };
  if (allowInterruption) {
    requestInterrupt = accept;
    if (ui?.interrupt) ui.interrupt.hidden = false;
    live = createLiveSpeechRecognizer({
      onUpdate: (heard) => {
        const spoken = ui?.spokenText || text;
        if (accepted || (!capturingSpeech && !isClearVoiceInterruption(heard, spoken))) return;
        if (!capturingSpeech) {
          capturingSpeech = true;
          haltPlayback(); // barge-in is immediate; delivery waits briefly for the whole utterance
          setState('listening');
          if (ui?.interrupt) ui.interrupt.hidden = true;
        }
        pendingSpeech = extractVoiceInterruption(heard, spoken) || heard.trim();
        setHeard(pendingSpeech);
        if (speechTimer) clearTimeout(speechTimer);
        speechTimer = setTimeout(() => accept({ text: pendingSpeech }), 700);
      },
    });
    live.start();
  }
  const options = {
    // One model-provided stream: native frames are queued continuously, never manually split into
    // sentence clips. The opening call keeps its prewarmed bytes and real phrase timestamps.
    continuous: true,
    preparedAudio,
    preparedSegments,
    preparedNative,
    onNative: () => { if (ui) { ui.nativeSpeech = true; renderVoiceControls(); } },
    ttsExtra: { voice: selectedVoice },
    onSlow: () => showTtsNotice('Spark voice is taking longer than usual. You can switch this conversation to your device voice.', { offerDevice: true, kind: 'slow' }),
    onStarted: () => { if (ui?.ttsNotice?.dataset.kind === 'slow') clearTtsNotice(); },
    onFallback: () => showTtsNotice('Spark voice is slow or unreachable, so this line is using your device voice. You can switch the rest too.', { offerDevice: true }),
    onReconnecting: () => showTtsNotice('Connection interrupted — reconnecting to the same report. Your words are kept; nothing is being regenerated.', { kind: 'reconnecting' }),
    onConnected: () => { if (ui?.ttsNotice?.dataset.kind === 'reconnecting') clearTtsNotice(); },
    onPartial: error => { partialFailure = error; },
    onSegment: focusSpokenSegment,
  };
  const run = realtime ? speakConversation(handle, { ...options, ...realtime, voiceId, voice: selectedVoice,
    onText: appendSpokenText,
  }).then(result => { if (result?.current) updateProgress(result.current); }) : speakSmart(text, handle, options);
  const playback = run.then(() => null, error => {
    partialFailure = error;
    showTtsNotice(error.message || 'Voice is unavailable. Your response is kept; please retry.', { offerDevice: true });
    return null;
  });
  const playbackOrCapture = playback.then(() => capturingSpeech ? interruption : null);
  const result = allowInterruption ? await Promise.race([playbackOrCapture, interruption]) : await playback;
  if (requestInterrupt === accept) requestInterrupt = null;
  if (speechTimer) clearTimeout(speechTimer);
  live?.abort();
  if (ui?.interrupt) ui.interrupt.hidden = true;
  // Let the stopped audio promise unwind, but never hold the conversation hostage to a browser that
  // missed its pause event.
  if (accepted) await Promise.race([playback, sleep(250)]);
  return accepted || (partialFailure ? { failed: true, error: partialFailure } : result);
}

// ---- on-device voice selection ----
// The user picks a voice in the picker (stored by voiceURI); speakBrowser uses it, else the
// system default. iOS/macOS expose many junk "novelty/Eloquence" voices (Grandpa, Grandma, Reed,
// Zarvox…) that sound robotic / like an ill old person — we hide those and only offer real,
// on-device (localService) English voices, so a pick can never be a broken/undownloaded voice.
const BAD_VOICE_RX = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|grandma|grandpa|reed|rocko|sandy|shelley|flo|eddy|junior|kathy|ralph|fred|deranged|hysterical|princess)\b/i;

function usableVoices() {
  try {
    // English, minus the novelty/Eloquence junk. Include online voices (e.g. Chrome's
    // "Google US English", which is high quality) but sort on-device first.
    return (speechSynthesis.getVoices() || [])
      .filter((v) => /^en/i.test(v.lang || '') && !BAD_VOICE_RX.test(v.name || ''))
      .sort((a, b) => (b.localService === a.localService ? (a.name || '').localeCompare(b.name || '') : b.localService - a.localService));
  } catch {
    return [];
  }
}

function recommendVoice(list) {
  if (!list.length) return null;
  const by = (re) => list.find((v) => re.test(v.name || ''));
  // a downloaded high-quality voice (name carries Enhanced/Premium) > Chrome's good online voice >
  // the system default > Samantha > anything local. (The web API hides the quality tier, so we
  // guess by name; on macOS/iOS every default voice is "compact" until you download Enhanced/Premium.)
  return by(/(enhanced|premium|neural|natural)/i) || by(/Google US English/i) || list.find((v) => v.localService && v.default) || by(/\bsamantha\b/i) || list.find((v) => v.localService) || list[0];
}

// A tap-to-test voice picker (self-contained DOM). Lists usable English voices (on-device first,
// good online ones too), hides novelty/Eloquence junk, marks the recommended one (★) and the current pick, and persists the choice.
export function openVoicePicker() {
  if (typeof speechSynthesis === 'undefined') { alert('This browser has no speech synthesis.'); return; }
  const SAMPLE = 'Hi, here is how I sound. You have three sessions waiting for your review.';
  try { speechSynthesis.getVoices(); } catch {}
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.65);display:flex;align-items:flex-end;justify-content:center';
  const panel = document.createElement('div');
  panel.style.cssText = 'background:#0e1015;border:1px solid #2a2f3a;border-radius:14px 14px 0 0;max-width:560px;width:100%;max-height:82vh;overflow:auto;padding:16px 16px 28px';
  root.appendChild(panel);
  document.body.appendChild(root);
  const close = () => { try { speechSynthesis.cancel(); } catch {} try { speechSynthesis.onvoiceschanged = null; } catch {} root.remove(); };
  root.addEventListener('click', (e) => { if (e.target === root) close(); });

  const curId = () => { try { return localStorage.getItem('aios_tts_voice') || ''; } catch { return ''; } };
  const row = (item, isCur, isRec) => {
    const r = document.createElement('div');
    r.style.cssText = 'display:flex;align-items:center;gap:8px;padding:9px 8px;border-radius:9px;margin-bottom:5px;' + (isCur ? 'background:#16243a;border:1px solid #2b6cb0' : 'background:#141822;border:1px solid #1c2230');
    const lab = document.createElement('div');
    lab.style.cssText = 'flex:1;min-width:0;font-size:13px';
    const sub = item._default ? 'your device default' : `${item.lang || ''} · ${item.localService ? 'on device' : '☁ online'}${/enhanced|premium/i.test(item.name || '') ? ' · enhanced' : ''}`;
    lab.innerHTML = `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item._default ? 'System default' : item.name}${isRec ? ' <span style="color:#6cc04a">★</span>' : ''}</div><div style="opacity:.5;font-size:11px">${sub}</div>`;
    const test = document.createElement('button'); test.className = 'btn ghost sm'; test.textContent = '▶ Test';
    test.onclick = () => { try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(SAMPLE); if (!item._default) { const vv = (speechSynthesis.getVoices() || []).find((v) => v.voiceURI === item.voiceURI); if (vv) u.voice = vv; } speechSynthesis.speak(u); } catch {} };
    const use = document.createElement('button'); use.className = isCur ? 'btn ghost sm' : 'btn sm'; use.textContent = isCur ? '✓ in use' : 'Use';
    use.onclick = () => { try { item._default ? localStorage.removeItem('aios_tts_voice') : localStorage.setItem('aios_tts_voice', item.voiceURI || item.name); } catch {} render(); };
    r.append(lab, test, use);
    return r;
  };
  const render = () => {
    const list = usableVoices();
    const rec = recommendVoice(list);
    const cur = curId();
    panel.innerHTML = '';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px';
    head.innerHTML = '<b style="font-size:15px">Speaking voice</b>';
    const x = document.createElement('button'); x.className = 'btn ghost sm'; x.textContent = 'Close'; x.onclick = close; head.appendChild(x);
    panel.appendChild(head);
    const note = document.createElement('div');
    note.style.cssText = 'font-size:12px;opacity:.65;margin:4px 0 12px;line-height:1.45';
    note.innerHTML = 'By default macOS/iOS only install <b>compact</b> (robotic) voices. For a natural voice, download an <b>Enhanced</b> or <b>Premium</b> English voice — macOS: System Settings → Accessibility → Spoken Content → System Voice → <b>Manage Voices…</b>; iOS: Settings → Accessibility → Spoken Content → Voices → English. Then reopen this and Test. (★ = recommended; ☁ = online, needs internet.)';
    panel.appendChild(note);
    panel.appendChild(row({ _default: true }, cur === '', false));
    for (const v of list) panel.appendChild(row(v, cur === (v.voiceURI || v.name), rec && v.voiceURI === rec.voiceURI));
    if (!list.length) {
      const w = document.createElement('div'); w.style.cssText = 'font-size:12px;opacity:.7;margin-top:8px';
      w.textContent = 'No usable English voices reported yet — reload the page, or download an Enhanced/Premium English voice in System Settings, then reopen.';
      panel.appendChild(w);
    }
  };
  render();
  try { speechSynthesis.onvoiceschanged = render; } catch {} // voices can load a beat late
}

// ---- STT ----
// agentHint (the current queue item's agent) matches dictation to that session's STT source server-side;
// sessionId grounds Whisper in that session's task/project vocabulary. `langs` (browser languages /
// aios_stt_langs override) lets the server reject wrong-language stock hallucinations — those came
// back as the operator's "reply" ("Продолжение следует…") and were fed to the intent brain (2026-08-12).
async function transcribe(blob, agentHint, sessionId) {
  if (!blob || blob.size < 1200) return '';
  const ctrl = new AbortController();
  captureAbort = ctrl;
  const t = setTimeout(() => ctrl.abort(), 30000); // never let STT wedge the loop
  try {
    const q = (agentHint ? `&agent=${encodeURIComponent(agentHint)}` : '')
      + (sessionId ? `&session=${encodeURIComponent(sessionId)}` : '')
      + `&langs=${encodeURIComponent(preferredSttLangs())}`;
    // Ordinary conversational feedback retains transcript cleanup before intent reasoning. Exact
    // assistant controls recognized locally bypass this request above, without altering that path.
    const r = await fetch('api/transcribe?language=auto&polish=true' + q, { method: 'POST', headers: { 'content-type': blob.type }, body: blob, signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (r.ok && !j.rejected) rememberSpeechLanguage(j.language, j.text);
    return r.ok ? (j.text || '').trim() : ''; // rejected → '' → the loop re-asks instead of acting on noise
  } catch {
    return ''; // timeout/abort/network -> empty -> server re-asks, loop continues
  } finally {
    clearTimeout(t);
    if (captureAbort === ctrl) captureAbort = null;
  }
}

function microphoneConstraints() {
  const supported = navigator.mediaDevices?.getSupportedConstraints?.() || {};
  const audio = {};
  if (supported.echoCancellation) audio.echoCancellation = true;
  if (supported.noiseSuppression) audio.noiseSuppression = true;
  if (supported.autoGainControl) audio.autoGainControl = true;
  if (supported.channelCount) audio.channelCount = { ideal: 1 };
  return Object.keys(audio).length ? { audio } : { audio: true };
}

function recorderOptions() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return {};
  for (const mimeType of ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType };
  }
  return {};
}

// ---- record until silence (energy VAD) ----
// getUserMedia rejections (NotAllowedError…) propagate TYPED to the caller — the loop names the
// cause and pauses instead of nagging forever. Everything after acquisition is try/finally so a
// constructor failure can never leak the mic.
async function recordUntilSilence({
  maxMs = 90000,
  silenceMs = VOICE_CAPTURE_DEFAULTS.silenceMs,
  graceMs = VOICE_CAPTURE_DEFAULTS.graceMs,
  threshold = VOICE_CAPTURE_DEFAULTS.threshold,
} = {}) {
  const stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints());
  const opts = recorderOptions();
  const chunks = [];
  let rec = null, src = null, privateCtx = null;
  try {
    rec = new MediaRecorder(stream, opts);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    // Analyser on the shared gesture-unlocked context (see unlockAudio); private context as belt.
    let an = null, buf = null, ac = null;
    try {
      ac = vadCtx;
      if (!ac) { const AC = window.AudioContext || window.webkitAudioContext; ac = privateCtx = new AC(); }
      if (ac.state !== 'running') await ac.resume().catch(() => {});
      an = ac.createAnalyser();
      an.fftSize = 1024;
      src = ac.createMediaStreamSource(stream);
      src.connect(an);
      buf = new Uint8Array(an.fftSize);
    } catch { an = null; }
    // If the analyser can't actually hear (still-suspended context), silence detection can't fire —
    // don't cut the reply at the 8s "nobody spoke" grace; give a longer bounded window instead.
    const vadDead = !an || ac.state !== 'running';
    const grace = vadDead ? Math.max(graceMs, 15000) : graceMs;
    rec.start(250);
    const t0 = Date.now();
    let lastVoice = t0;
    let spoke = false;
    await new Promise((resolve) => {
      const tick = () => {
        if (stopFlag || pendingDismiss) return resolve();
        let rms = 0;
        if (an) {
          an.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const d = (buf[i] - 128) / 128;
            sum += d * d;
          }
          rms = Math.sqrt(sum / buf.length);
        }
        const t = Date.now();
        if (rms > threshold) { lastVoice = t; spoke = true; }
        if (ui && ui.orb) ui.orb.style.transform = `scale(${(1 + Math.min(rms * 4, 1)).toFixed(2)})`;
        const done = t - t0 > maxMs || (spoke && t - lastVoice > silenceMs) || (!spoke && t - t0 > grace);
        done ? resolve() : setTimeout(tick, 100); // NOT rAF — background tabs freeze rAF and wedge the loop here
      };
      tick();
    });
    const stopped = new Promise((r) => { rec.onstop = r; }); // installed BEFORE stop() so the event can't be missed
    try { rec.stop(); } catch {}
    await Promise.race([stopped, sleep(600)]);
  } finally {
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch {}
    try { stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { src?.disconnect(); } catch {}
    if (privateCtx) { try { await privateCtx.close(); } catch {} }
    if (ui && ui.orb) ui.orb.style.transform = 'scale(1)';
  }
  return new Blob(chunks, { type: rec?.mimeType || opts.mimeType || chunks[0]?.type || 'audio/webm' });
}

// ---- visual check (Preview) ----
// Operator: "in voice mode it's hard to tell whether it actually changed anything — I want a button
// that shows the raw screenshots, desktop/iPad/phone, prepared automatically". The server pre-captures
// on item advance; this panel renders the manifest (viewport shots + images already in the session
// log). The voice loop keeps running while it's open — glance, then just speak the response.
const PREVIEW_PANEL_HTML =
  '<div class="vm-preview-panel" hidden>' +
  '<div class="vm-preview-head"><span class="vm-preview-title">VISUAL CHECK</span><div class="vm-preview-tabs"></div>' +
  '<button class="vm-preview-x" type="button" aria-label="Close preview">✕</button></div>' +
  '<div class="vm-preview-body"><div class="vm-preview-empty">Loading…</div></div>' +
  '<div class="vm-preview-strip" hidden></div></div>';
const VIEWPORT_LABEL = { desktop: 'Desktop', tablet: 'iPad', phone: 'Phone' };
let previewTimer = null;
let previewPollLeft = 0;

function wirePreview(o) {
  if (!o.preview || !o.previewPanel) return;
  o.preview.onclick = () => {
    if (!o.previewPanel.hidden) return closePreviewPanel();
    o.previewPanel.hidden = false;
    o.preview.classList.add('on');
    loadPreviewPanel(true);
  };
  o.previewPanel.querySelector('.vm-preview-x').onclick = closePreviewPanel;
}

function closePreviewPanel() {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
  if (ui?.previewPanel) { ui.previewPanel.hidden = true; ui.previewPanel.dataset.sid = ''; delete ui.previewPanel.dataset.pick; }
  ui?.preview?.classList.remove('on');
}

async function loadPreviewPanel(fresh) {
  const sid = ui?.sessionId;
  const panel = ui?.previewPanel;
  if (!sid || !panel || panel.hidden) return;
  if (fresh) { previewPollLeft = 10; delete panel.dataset.pick; }
  panel.dataset.sid = sid;
  let man = null;
  try { man = await api(`api/session/${encodeURIComponent(sid)}/voice-preview?prepare=1`); } catch {}
  if (!ui || panel.hidden || panel.dataset.sid !== ui.sessionId) return; // closed / advanced meanwhile
  renderPreview(panel, man || {});
  // Viewport shots may still be capturing (the loop pre-captures, but a fast tap can win) — poll a
  // few rounds until the set is complete, then stop.
  const incomplete = man && man.previewUrl && (man.viewports || []).length < 3;
  if (incomplete && previewPollLeft-- > 0) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => loadPreviewPanel(false), 2500);
  }
}

function renderPreview(panel, man) {
  const tabs = panel.querySelector('.vm-preview-tabs');
  const body = panel.querySelector('.vm-preview-body');
  const strip = panel.querySelector('.vm-preview-strip');
  const shots = [
    ...(man.viewports || []).map((v) => ({ id: `vp:${v.key}`, name: VIEWPORT_LABEL[v.key] || v.key, url: `${v.url}?t=${v.ts}`, tab: true })),
    ...(man.logImages || []).map((s, i) => ({ id: `log:${i}`, name: s.label || 'from the log', url: s.url, tab: false })),
  ];
  if (!panel.dataset.pick || !shots.some((s) => s.id === panel.dataset.pick)) panel.dataset.pick = shots[0]?.id || '';
  const pick = shots.find((s) => s.id === panel.dataset.pick) || null;
  const choose = (id) => { panel.dataset.pick = id; renderPreview(panel, man); };
  tabs.replaceChildren(...shots.filter((s) => s.tab).map((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = s.name;
    b.classList.toggle('on', s.id === panel.dataset.pick);
    b.onclick = () => choose(s.id);
    return b;
  }));
  const logShots = shots.filter((s) => !s.tab);
  strip.hidden = !logShots.length;
  strip.replaceChildren(...logShots.map((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = s.name;
    b.classList.toggle('on', s.id === panel.dataset.pick);
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = s.url;
    img.alt = s.name;
    b.appendChild(img);
    b.onclick = () => choose(s.id);
    return b;
  }));
  if (pick) {
    const img = document.createElement('img');
    img.src = pick.url;
    img.alt = pick.name;
    body.replaceChildren(img);
  } else {
    const empty = document.createElement('div');
    empty.className = 'vm-preview-empty';
    empty.textContent = man.previewUrl
      ? 'Capturing desktop, iPad, and phone screenshots…'
      : 'No screenshots for this session yet — no preview URL is configured and the agent has not produced any images.';
    body.replaceChildren(empty);
  }
}

// ---- overlay UI ----
function buildOverlay({ onTheGo = false, initialText = '' } = {}) {
  const root = document.createElement('div');
  root.className = onTheGo ? 'vm vm-ongo' : 'vm';
  root.innerHTML = onTheGo
    ? '<div class="ongo-shell">' +
      '<div class="ongo-head"><div><span class="ongo-kicker">VOICE ASSISTANT</span><h2 class="ongo-title">Project update</h2></div>' +
      '<div class="ongo-live"><i></i><span class="vm-state">Starting…</span></div></div>' +
      '<div class="ongo-track"><div><span class="ongo-context">Ask a follow-up or give feedback naturally</span><span class="vm-prog-label"></span></div><div class="vm-bar"><i></i></div></div>' +
      '<div class="ongo-sources" aria-label="Report sources" hidden></div>' +
      '<div class="ongo-dialog">' +
      '<section class="ongo-report"><span class="ongo-label ongoing-spoken-label">BRIEFING</span><div class="vm-said"></div></section>' +
      '<section class="ongo-heard"><span class="ongo-label ongoing-heard-label">YOUR RESPONSE</span><div class="vm-heard empty">Your words will stay here.</div></section>' +
      '<div class="ongo-delivery" hidden></div></div>' +
      '<div class="vm-tts-notice" hidden></div>' +
      '<div class="ongo-foot"><details class="ongo-settings"><summary>Voice &amp; speed</summary><div class="vm-controls"><span class="vm-mode"></span>' +
      '<div class="vm-speed" role="group" aria-label="Speech speed"></div>' +
      '<button class="btn ghost sm vm-device-voice" type="button" hidden>Use device voice</button></div></details>' +
      '<div class="ongo-actions"><button class="btn ghost vm-preview" type="button" title="See the screenshots for this session — desktop, iPad, and phone">Preview</button>' +
      '<button class="btn ghost vm-dismiss" type="button" hidden title="Dismiss this report on every device, without stopping the session">Dismiss report</button>' +
      '<button class="btn vm-interrupt" type="button" hidden>Speak now</button>' +
      '<button class="btn danger vm-stop">End assistant</button></div></div>' +
      PREVIEW_PANEL_HTML + '</div>'
    : '<div class="vm-box">' +
      '<div class="vm-progress"><div class="vm-bar"><i></i></div><div class="vm-prog-label"></div></div>' +
      '<div class="vm-orb"></div>' +
      '<div class="vm-state">Starting…</div>' +
      '<div class="vm-said"></div>' +
      '<div class="vm-heard"></div>' +
      '<div class="vm-controls"><span class="vm-mode"></span>' +
      '<div class="vm-speed" role="group" aria-label="Speech speed"></div>' +
      '<button class="btn ghost sm vm-device-voice" type="button" hidden>Use device voice</button></div>' +
      '<div class="vm-tts-notice" hidden></div>' +
      '<div class="vm-action-row"><button class="btn ghost vm-preview" type="button" title="See the screenshots for this session — desktop, iPad, and phone">Preview</button>' +
      '<button class="btn ghost vm-dismiss" type="button" hidden>Dismiss report</button>' +
      '<button class="btn vm-interrupt" type="button" hidden>Speak now</button>' +
      '<button class="btn danger vm-stop">Stop</button></div>' +
      PREVIEW_PANEL_HTML + '</div>';
  document.body.appendChild(root);
  if (initialText) root.querySelector('.vm-said').textContent = initialText;
  const o = {
    root,
    orb: root.querySelector('.vm-orb'),
    state: root.querySelector('.vm-state'),
    said: root.querySelector('.vm-said'),
    heard: root.querySelector('.vm-heard'),
    bar: root.querySelector('.vm-bar > i'),
    prog: root.querySelector('.vm-prog-label'),
    mode: root.querySelector('.vm-mode'),
    speed: root.querySelector('.vm-speed'),
    deviceVoice: root.querySelector('.vm-device-voice'),
    ttsNotice: root.querySelector('.vm-tts-notice'),
    delivery: root.querySelector('.ongo-delivery'),
    title: root.querySelector('.ongo-title'),
    context: root.querySelector('.ongo-context'),
    sources: root.querySelector('.ongo-sources'),
    spokenLabel: root.querySelector('.ongoing-spoken-label'),
    heardLabel: root.querySelector('.ongoing-heard-label'),
    interrupt: root.querySelector('.vm-interrupt'),
    preview: root.querySelector('.vm-preview'),
    dismiss: root.querySelector('.vm-dismiss'),
    previewPanel: root.querySelector('.vm-preview-panel'),
    onTheGo,
  };
  wirePreview(o);
  root.querySelector('.vm-stop').onclick = () => end('user');
  o.interrupt.onclick = () => requestInterrupt?.({ tap: true });
  o.dismiss.onclick = () => {
    if (!voiceId || !o.reportId || pendingDismiss) return;
    pendingDismiss = { sessionId: o.sessionId, reportId: o.reportId };
    o.dismiss.disabled = true;
    controlAbort?.abort(); captureAbort?.abort();
    if (recoveryResume) { recoveryResume(false); recoveryResume = null; requestInterrupt = null; }
    else requestInterrupt?.({ dismiss: true });
    try { handle?.stop(); stopAllPlayback(); } catch {}
    setState('thinking');
  };
  o.deviceVoice.onclick = () => {
    if (ttsMode() === 'browser') {
      setTtsMode('neural');
      showTtsNotice('Using Omni voice for the next response.', { offerDevice: true });
    } else {
      setTtsMode('browser');
      showTtsNotice('Using your device voice for the rest of this voice conversation.', { offerDevice: true });
    }
  };
  renderVoiceControls();
  if (ttsMode() === 'browser') showTtsNotice('Using your device voice. You can switch back to Omni when ready.', { offerDevice: true });
  return o;
}
function updateProgress(cur) {
  if (!ui || !cur || !cur.total) return;
  if (ui.onTheGo && ui.sessionId && cur.sessionId && ui.sessionId !== cur.sessionId) {
    // The transcript and delivery receipt are evidence for the previous session, not global voice
    // state. Clear them only when /continue actually presents the next session.
    if (ui.heard) {
      ui.heard.textContent = 'Your words will stay here.';
      ui.heard.classList.add('empty');
    }
    if (ui.heardLabel) ui.heardLabel.textContent = 'YOUR RESPONSE';
    if (ui.delivery) {
      ui.delivery.hidden = true;
      ui.delivery.textContent = '';
    }
    if (ui.spokenLabel) ui.spokenLabel.textContent = 'BRIEFING';
  }
  ui.sessionId = cur.sessionId || ui.sessionId || '';
  ui.reportId = Number(cur.reportId) || null;
  if (ui.dismiss) { ui.dismiss.hidden = !ui.reportId; ui.dismiss.disabled = false; }
  // An open visual check follows the queue: advancing to the next session reloads its screenshots.
  if (ui.previewPanel && !ui.previewPanel.hidden && ui.previewPanel.dataset.sid && ui.previewPanel.dataset.sid !== ui.sessionId) loadPreviewPanel(true);
  ui.prog.textContent = ui.onTheGo ? `${cur.n} of ${cur.total}` : `Item ${cur.n} of ${cur.total}`;
  ui.bar.style.width = Math.round((cur.n / cur.total) * 100) + '%';
  if (ui.onTheGo) {
    if (ui.title) ui.title.textContent = cur.projectIdentity || cur.project || 'Project update';
    if (ui.context) ui.context.textContent = voiceThreadLabel(cur) || cur.category || 'Needs You';
    renderVoiceSources(cur.sourceNames || []);
  }
}

function voiceThreadLabel(cur) {
  const parts = [];
  for (const value of [cur.topic, cur.module, cur.workstream]) {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (parts.some((part) => part.toLowerCase() === key || part.toLowerCase().includes(key) || key.includes(part.toLowerCase()))) continue;
    parts.push(clean);
  }
  return parts.slice(0, 2).join(' · ');
}

function renderVoiceSources(names) {
  if (!ui?.sources) return;
  const clean = [...new Set((Array.isArray(names) ? names : []).map((name) => String(name || '').trim()).filter(Boolean))].slice(0, 4);
  ui.sources.hidden = !clean.length;
  ui.sources.replaceChildren(...clean.map((name) => {
    const chip = document.createElement('span');
    chip.className = 'ongo-source';
    chip.textContent = name;
    return chip;
  }));
}
function updateDelivery(delivery, sentCount = 0) {
  if (!ui?.delivery || !delivery) return;
  ui.delivery.hidden = false;
  if (delivery.status === 'skipped') {
    ui.delivery.classList.remove('failed');
    ui.delivery.textContent = delivery.reason === 'operator-review-later' ? 'Left for your later review · nothing sent'
      : delivery.reason === 'report-acknowledged' ? 'Report acknowledged · nothing sent'
      : delivery.reason === 'pending-not-sent' ? 'Skipped this pass · draft not sent' : 'Skipped this pass · nothing sent';
    return;
  }
  ui.delivery.classList.toggle('failed', delivery.status !== 'sent');
  ui.delivery.textContent = delivery.status === 'sent'
    ? `✓ Sent to ${delivery.project}${sentCount > 1 ? ` · ${sentCount} sent` : ''}`
    : `Not sent · ${String(delivery.status || 'delivery failed').replace(/-/g, ' ')}`;
}
function setState(s, said) {
  if (!ui) return;
  ui.root.dataset.state = s;
  ui.state.textContent = { speaking: 'Speaking…', listening: 'Listening…', thinking: 'Thinking…', paused: 'Connection paused', error: 'Error' }[s] || s;
  if (said != null) paintSpokenText(said);
  if (ui.onTheGo && s === 'listening' && ui.heard?.classList.contains('empty')) {
    ui.heard.textContent = 'Listening — your words will appear here.';
  }
}

function paintSpokenText(text) {
  if (!ui?.said) return;
  if (!ui.onTheGo) {
    ui.said.textContent = text;
    return;
  }
  ui.spokenText = String(text || ''); ui.spokenEnd = 0; ui.spokenKey = '';
  ui.said.replaceChildren(...['done', 'current', 'pending'].map(kind => {
    const span = document.createElement('span');
    span.className = `ongo-segment ${kind}`;
    span.dataset.speechPart = kind;
    span.textContent = kind === 'current' ? ui.spokenText : '';
    return span;
  }));
}

function appendSpokenText(delta) {
  if (!ui?.said || stopFlag) return;
  ui.spokenText = (ui.spokenText || '') + delta;
  const pending = ui.said.querySelector('[data-speech-part="pending"]');
  if (pending) pending.textContent = ui.spokenText.slice(ui.spokenEnd || 0);
  else ui.said.textContent = ui.spokenText;
}

function focusSpokenSegment(segment = {}) {
  if (!ui?.onTheGo || !ui.said) return;
  const key = `${segment.index}:${segment.text}`;
  if (key === ui.spokenKey) return;
  const range = speechTextRange(ui.spokenText, segment.text, ui.spokenEnd);
  if (!range) return; // Unknown metadata cannot invent a current-reading position.
  const current = ui.said.querySelector('[data-speech-part="current"]');
  if (!current) return;
  ui.spokenKey = key; ui.spokenEnd = range.end;
  ui.said.querySelector('[data-speech-part="done"]').textContent = ui.spokenText.slice(0, range.start);
  current.textContent = ui.spokenText.slice(range.start, range.end);
  ui.said.querySelector('[data-speech-part="pending"]').textContent = ui.spokenText.slice(range.end);
  const box = current.getBoundingClientRect(), parent = ui.said.getBoundingClientRect();
  if (box.top < parent.top || box.bottom > parent.bottom) current.scrollIntoView?.({ block: 'nearest' });
}

function setHeard(text) {
  if (!ui?.heard || !text) return;
  ui.heard.textContent = `“${text}”`;
  ui.heard.classList.remove('empty');
  ui.heard.classList.remove('ignored');
  if (ui.heardLabel) ui.heardLabel.textContent = 'YOUR LAST RESPONSE';
}

function markIgnoredSpeech(reason = '') {
  if (!ui?.onTheGo || !ui.heard) return;
  ui.heard.classList.add('ignored');
  if (ui.heardLabel) ui.heardLabel.textContent = reason === 'no-speech' ? 'NO RESPONSE · NOTHING SENT' : reason === 'fragment' ? 'AUDIO FRAGMENT · NOT USED' : 'HEARD NEARBY · NOT USED';
  if (reason === 'no-speech') ui.heard.textContent = 'Still listening for your reply.';
  else if (reason === 'fragment') ui.heard.textContent = 'A clipped sound was ignored. Still listening.';
}
