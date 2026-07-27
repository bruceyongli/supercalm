import { unlockAudio, newPlayback, speakSmart, stopAllPlayback } from './tts-player.js';

const $ = (selector) => document.querySelector(selector);
const statusPill = $('#status-pill');
const statusLabel = statusPill.querySelector('b');
const detail = $('#connection-detail');
const setup = $('#setup');
const setupTitle = $('#setup-title');
const setupCopy = $('#setup-copy');
const useFallback = $('#use-fallback');
const modeSelect = $('#mode');
const voiceSelect = $('#voice');
const startButton = $('#start');
const stopButton = $('#stop');
const transcript = $('#transcript');
const events = $('#events');
const remoteAudio = $('#remote-audio');
const textForm = $('#text-form');
const textInput = $('#text-input');
const textSubmit = textForm.querySelector('button');
const speechInputRoute = $('#speech-input-route');
const responseRoute = $('#response-route');
const speechOutputRoute = $('#speech-output-route');
const pipelineNote = $('#pipeline-note');

let mode = null;
let peer = null;
let media = null;
let channel = null;
let sessionId = null;
let partialAssistant = '';
let bridgeBusy = false;
let playback = null;
let capability = null;

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = response.status === 404 && path === 'api/codex-realtime/status'
        ? 'The AIOS voice service is out of date. Restart AIOS and reload this page.'
        : body.error || `Request failed (${response.status})`;
      const error = new Error(message);
      error.code = body.code;
      error.status = response.status;
      throw error;
    }
    return body;
  });
}

function setStatus(kind, label, message) {
  statusPill.className = `status ${kind}`;
  statusLabel.textContent = label;
  detail.textContent = message;
}

function log(label, payload) {
  const line = `${new Date().toLocaleTimeString()}  ${label}${payload ? `  ${JSON.stringify(payload)}` : ''}`;
  events.textContent = events.textContent.startsWith('Waiting') ? line : `${line}\n${events.textContent}`;
}

function addTurn(role, text, { partial = false } = {}) {
  transcript.querySelector('.empty')?.remove();
  let row = partial ? transcript.querySelector('.turn.assistant.partial') : null;
  if (!row) {
    row = document.createElement('div');
    row.className = `turn ${role}${partial ? ' partial' : ''}`;
    const who = document.createElement('b');
    who.textContent = role === 'assistant' ? 'Codex' : 'You';
    const copy = document.createElement('p');
    row.append(who, copy);
    transcript.append(row);
  }
  row.querySelector('p').textContent = text;
  transcript.scrollTop = transcript.scrollHeight;
  return row;
}

function finalizeAssistant(text) {
  const row = transcript.querySelector('.turn.assistant.partial');
  if (row) {
    row.classList.remove('partial');
    row.querySelector('p').textContent = text || partialAssistant;
  } else if (text) {
    addTurn('assistant', text);
  }
  partialAssistant = '';
}

function handleRealtimeEvent(event) {
  log(event.type || 'data-channel', {
    item_id: event.item_id,
    response_id: event.response_id,
    transcript: event.transcript,
    error: event.error?.message,
  });
  switch (event.type) {
    case 'conversation.item.input_audio_transcription.completed':
      if (event.transcript) addTurn('user', event.transcript);
      break;
    case 'response.audio_transcript.delta':
    case 'response.output_audio_transcript.delta':
      partialAssistant += event.delta || '';
      addTurn('assistant', partialAssistant, { partial: true });
      break;
    case 'response.audio_transcript.done':
    case 'response.output_audio_transcript.done':
      finalizeAssistant(event.transcript || partialAssistant);
      break;
    case 'response.done':
      finalizeAssistant(partialAssistant);
      break;
    case 'error':
      setStatus('error', 'Native error', event.error?.message || 'Realtime session error');
      break;
  }
}

function waitForIceGathering(pc, timeoutMs = 5000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== 'complete') return;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', done);
    };
    pc.addEventListener('icegatheringstatechange', done);
  });
}

function recorderOptions() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return {};
  for (const mimeType of ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType };
  }
  return {};
}

async function recordUntilSilence({ maxMs = 60_000, silenceMs = 1400, graceMs = 8000 } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    video: false,
  });
  const chunks = [];
  const options = recorderOptions();
  let recorder;
  let audioContext;
  let source;
  try {
    recorder = new MediaRecorder(stream, options);
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    let analyser = null;
    let samples = null;
    try {
      audioContext = new AudioContext();
      await audioContext.resume().catch(() => {});
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      samples = new Uint8Array(analyser.fftSize);
      source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
    } catch {}
    recorder.start(200);
    const startedAt = Date.now();
    let lastVoiceAt = startedAt;
    let heardVoice = false;
    await new Promise((resolve) => {
      const sample = () => {
        const now = Date.now();
        let rms = 0;
        if (analyser && samples) {
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const value of samples) {
            const centered = (value - 128) / 128;
            sum += centered * centered;
          }
          rms = Math.sqrt(sum / samples.length);
        }
        if (rms > 0.04) {
          heardVoice = true;
          lastVoiceAt = now;
        }
        if (
          now - startedAt >= maxMs
          || (heardVoice && now - lastVoiceAt >= silenceMs)
          || (!heardVoice && now - startedAt >= graceMs)
        ) {
          resolve();
        } else {
          setTimeout(sample, 100);
        }
      };
      sample();
    });
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.stop();
    await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 600))]);
  } finally {
    try { if (recorder?.state !== 'inactive') recorder.stop(); } catch {}
    stream.getTracks().forEach((track) => track.stop());
    try { source?.disconnect(); } catch {}
    try { await audioContext?.close(); } catch {}
  }
  return new Blob(chunks, { type: recorder?.mimeType || options.mimeType || chunks[0]?.type || 'audio/webm' });
}

async function transcribe(blob) {
  if (!blob || blob.size < 800) return '';
  const response = await fetch('api/transcribe?language=auto&polish=false', {
    method: 'POST',
    headers: { 'content-type': blob.type || 'audio/webm' },
    body: blob,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Transcription failed (${response.status})`);
  return String(body.text || '').trim();
}

async function ensureBridgeSession() {
  if (sessionId) return { id: sessionId };
  const result = await api('api/codex-realtime/bridge/start', { method: 'POST', body: '{}' });
  sessionId = result.id;
  stopButton.disabled = false;
  log('bridge started', { model: result.model, startupMs: result.startupMs });
  return result;
}

function isRecoverableBridgeError(error) {
  return error?.code === 'session-not-found'
    || [502, 503, 504].includes(error?.status)
    || error instanceof TypeError;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function recoverBridgeSession(error) {
  if (!isRecoverableBridgeError(error)) throw error;
  log('bridge reconnecting', { code: error.code, status: error.status });
  sessionId = null;
  stopButton.disabled = true;
  setStatus('checking', 'Fallback reconnecting', 'AIOS restarted during the turn. Reconnecting without losing your transcript…');
  let lastError = error;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await wait(attempt * 400);
    try {
      return await ensureBridgeSession();
    } catch (nextError) {
      lastError = nextError;
      if (!isRecoverableBridgeError(nextError)) throw nextError;
    }
  }
  throw lastError;
}

async function requestBridgeTurn(text) {
  const send = () => api(`api/codex-realtime/${encodeURIComponent(sessionId)}/bridge/turn`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  try {
    return await send();
  } catch (error) {
    await recoverBridgeSession(error);
    log('bridge reconnected', { sessionId });
    return send();
  }
}

async function runBridgeText(text) {
  addTurn('user', text);
  setStatus('checking', 'Fallback thinking', 'Codex is preparing a short text response for local speech synthesis…');
  const result = await requestBridgeTurn(text);
  addTurn('assistant', result.text);
  log('bridge turn', { model: result.model, firstTokenMs: result.firstTokenMs, latencyMs: result.latencyMs });
  setStatus('live', 'Fallback speaking', `${result.model} answered in ${(result.latencyMs / 1000).toFixed(1)}s; Kokoro is speaking locally.`);
  startButton.querySelector('[data-label]').textContent = 'Speaking…';
  playback = newPlayback();
  await speakSmart(result.text, playback);
  setStatus('ready', 'Fallback ready', 'Local Whisper and Kokoro are active; this is not native Codex realtime.');
}

async function bridgeVoiceTurn() {
  if (bridgeBusy) return;
  bridgeBusy = true;
  unlockAudio();
  stopAllPlayback();
  startButton.disabled = true;
  startButton.querySelector('[data-label]').textContent = 'Listening…';
  setStatus('live', 'Fallback listening', 'Local Whisper recording is active. The turn ends after a short silence.');
  try {
    // Warm the Codex thread while the operator is speaking so first-turn setup
    // is hidden behind microphone time instead of added after it.
    const session = ensureBridgeSession();
    const recording = recordUntilSilence();
    const [, blob] = await Promise.all([session, recording]);
    setStatus('checking', 'Fallback transcribing', 'Local Whisper is transcribing this turn…');
    const text = await transcribe(blob);
    if (!text) {
      setStatus('ready', 'Fallback ready', 'Local Whisper did not hear speech. Tap Speak and try again.');
      return;
    }
    await runBridgeText(text);
  } catch (error) {
    log('bridge failed', { code: error.code, message: error.message });
    setStatus('error', 'Fallback error', error.message);
  } finally {
    bridgeBusy = false;
    startButton.disabled = false;
    startButton.querySelector('[data-label]').textContent = 'Speak again';
  }
}

async function startNative() {
  startButton.disabled = true;
  startButton.querySelector('[data-label]').textContent = 'Connecting…';
  setStatus('checking', 'Native connecting', 'Requesting microphone access and creating the Codex WebRTC offer…');
  try {
    media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    peer = new RTCPeerConnection();
    peer.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0] || new MediaStream([event.track]);
      remoteAudio.play().catch(() => {});
    };
    peer.onconnectionstatechange = () => {
      log('peer state', { state: peer?.connectionState });
      if (peer?.connectionState === 'failed') {
        setStatus('error', 'Native disconnected', 'The realtime peer connection failed.');
      }
    };
    media.getAudioTracks().forEach((track) => peer.addTrack(track, media));
    channel = peer.createDataChannel('oai-events');
    channel.onopen = () => log('data channel open');
    channel.onmessage = (message) => {
      try { handleRealtimeEvent(JSON.parse(message.data)); }
      catch { log('unparsed event'); }
    };
    channel.onerror = () => setStatus('error', 'Native channel error', 'The realtime event channel failed.');

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForIceGathering(peer);
    const result = await api('api/codex-realtime/start', {
      method: 'POST',
      body: JSON.stringify({ sdp: peer.localDescription.sdp, voice: voiceSelect.value }),
    });
    sessionId = result.id;
    await peer.setRemoteDescription({ type: 'answer', sdp: result.sdp });
    startButton.querySelector('[data-label]').textContent = 'Listening';
    stopButton.disabled = false;
    textInput.disabled = false;
    textSubmit.disabled = false;
    setStatus('live', 'Native live', `Connected to ${result.voice} over Codex realtime ${result.version}.`);
    log('native session started', { threadId: result.threadId, voice: result.voice, version: result.version });
  } catch (error) {
    log('native start failed', { code: error.code, message: error.message });
    await stop({ remote: false });
    setStatus('error', 'Native unavailable', error.message);
  }
}

function renderIdle() {
  if (mode === 'bridge') {
    startButton.disabled = false;
    startButton.querySelector('[data-label]').textContent = 'Speak';
    textInput.disabled = false;
    textSubmit.disabled = false;
    setStatus('ready', 'Fallback ready', 'Local Whisper and Kokoro are active; this is not native Codex realtime.');
  } else if (mode === 'native') {
    startButton.disabled = false;
    startButton.querySelector('[data-label]').textContent = 'Start realtime';
    textInput.disabled = true;
    textSubmit.disabled = true;
    setStatus('ready', 'Native ready', 'Microphone audio and synthesized speech will use the Codex Realtime WebRTC endpoint.');
  }
}

function showPipeline(pipeline, note) {
  speechInputRoute.textContent = pipeline?.speechInput
    ? `${pipeline.speechInput.location} · ${pipeline.speechInput.model}`
    : 'Unavailable';
  responseRoute.textContent = pipeline?.response
    ? `${pipeline.response.location} · ${pipeline.response.model}`
    : 'Unavailable';
  speechOutputRoute.textContent = pipeline?.speechOutput
    ? `${pipeline.speechOutput.location} · ${pipeline.speechOutput.model}`
    : 'Unavailable';
  pipelineNote.textContent = note;
}

function populateNativeVoices() {
  const voices = capability?.voices?.v2 || [];
  voiceSelect.replaceChildren(...voices.map((voice) => {
    const option = document.createElement('option');
    option.value = voice;
    option.textContent = voice[0].toUpperCase() + voice.slice(1);
    option.selected = voice === (capability?.voices?.defaultV2 || 'marin');
    return option;
  }));
}

function renderMode(nextMode) {
  mode = nextMode;
  modeSelect.value = nextMode;
  stopButton.disabled = true;
  if (mode === 'native') {
    populateNativeVoices();
    voiceSelect.disabled = !capability?.nativeReady;
    showPipeline(
      capability?.pipelines?.native,
      capability?.nativeReady
        ? 'This test sends microphone audio to OpenAI and receives synthesized audio over native Codex WebRTC.'
        : 'Native mode is selected, but no audio or transcript is being sent until API-key setup is complete.',
    );
    if (!capability?.nativeReady) {
      setup.hidden = false;
      setupTitle.textContent = 'Platform API key needed for native Codex realtime.';
      setupCopy.textContent = capability?.setup || 'Add OPENAI_API_KEY to the private AIOS environment and restart.';
      useFallback.hidden = !capability?.bridgeReady;
      startButton.disabled = true;
      startButton.querySelector('[data-label]').textContent = 'Native unavailable';
      textInput.disabled = true;
      textSubmit.disabled = true;
      setStatus('blocked', 'Native unavailable', 'The native Codex Realtime endpoint is not connected. No fallback is running.');
      return;
    }
    setup.hidden = true;
    useFallback.hidden = true;
    renderIdle();
    return;
  }

  voiceSelect.replaceChildren(new Option('Local Kokoro', 'bridge', true, true));
  voiceSelect.disabled = true;
  showPipeline(
    capability?.pipelines?.bridge,
    'Fallback mode keeps microphone audio on AIOS. Only transcript text and conversation are sent to Codex.',
  );
  if (!capability?.bridgeReady) {
    setup.hidden = false;
    setupTitle.textContent = 'Codex sign-in needed for fallback mode.';
    setupCopy.textContent = 'Sign in to the installed Codex CLI, then restart AIOS.';
    useFallback.hidden = true;
    startButton.disabled = true;
    textInput.disabled = true;
    textSubmit.disabled = true;
    setStatus('blocked', 'Fallback unavailable', 'The installed Codex CLI is not signed in.');
    return;
  }
  setup.hidden = true;
  useFallback.hidden = true;
  renderIdle();
}

async function stop({ remote = true } = {}) {
  const id = sessionId;
  sessionId = null;
  if (remote && id) {
    api(`api/codex-realtime/${encodeURIComponent(id)}/stop`, { method: 'POST', body: '{}' }).catch(() => {});
  }
  try { playback?.stop(); } catch {}
  stopAllPlayback();
  channel?.close();
  peer?.close();
  media?.getTracks().forEach((track) => track.stop());
  channel = null;
  peer = null;
  media = null;
  remoteAudio.srcObject = null;
  stopButton.disabled = true;
  renderIdle();
}

async function loadStatus() {
  try {
    const result = await api('api/codex-realtime/status');
    capability = result;
    log('capability', {
      preferredMode: result.preferredMode,
      authType: result.authType,
      nativeAuthType: result.nativeAuthType,
      nativeReady: result.nativeReady,
      bridgeReady: result.bridgeReady,
    });
    const nativeOption = new Option(
      result.nativeReady ? 'Native Codex realtime · ready' : 'Native Codex realtime · API key needed',
      'native',
      true,
      true,
    );
    const fallbackOption = new Option('Local speech fallback · Whisper + Kokoro', 'bridge');
    fallbackOption.disabled = !result.bridgeReady;
    modeSelect.replaceChildren(nativeOption, fallbackOption);
    modeSelect.disabled = false;
    renderMode('native');
  } catch (error) {
    log('capability failed', { code: error.code, message: error.message });
    setStatus('error', 'Unavailable', error.message);
  }
}

startButton.addEventListener('click', () => {
  if (mode === 'bridge') bridgeVoiceTurn();
  else if (mode === 'native') startNative();
});
modeSelect.addEventListener('change', async () => {
  if (sessionId) await stop();
  renderMode(modeSelect.value);
});
useFallback.addEventListener('click', () => {
  modeSelect.value = 'bridge';
  renderMode('bridge');
});
stopButton.addEventListener('click', () => stop());
$('#clear').addEventListener('click', () => {
  transcript.innerHTML = '<p class="empty">Transcript cleared. The active voice session is unchanged.</p>';
  partialAssistant = '';
});
textForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (!text || bridgeBusy) return;
  textInput.value = '';
  if (mode === 'bridge') {
    bridgeBusy = true;
    unlockAudio();
    try {
      await ensureBridgeSession();
      await runBridgeText(text);
    } catch (error) {
      setStatus('error', 'Fallback send failed', error.message);
    } finally {
      bridgeBusy = false;
    }
    return;
  }
  if (!sessionId) return;
  addTurn('user', text);
  try {
    await api(`api/codex-realtime/${encodeURIComponent(sessionId)}/text`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  } catch (error) {
    setStatus('error', 'Native send failed', error.message);
  }
});
window.addEventListener('pagehide', () => {
  if (sessionId) {
    navigator.sendBeacon?.(
      `api/codex-realtime/${encodeURIComponent(sessionId)}/stop`,
      new Blob(['{}'], { type: 'application/json' }),
    );
  }
  media?.getTracks().forEach((track) => track.stop());
  peer?.close();
  stopAllPlayback();
});

loadStatus();
