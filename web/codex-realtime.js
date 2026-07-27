import { unlockAudio, newPlayback, speakSmart, stopAllPlayback } from './tts-player.js';

const $ = (selector) => document.querySelector(selector);
const statusPill = $('#status-pill');
const statusLabel = statusPill.querySelector('b');
const detail = $('#connection-detail');
const setup = $('#setup');
const setupCopy = $('#setup-copy');
const voiceSelect = $('#voice');
const startButton = $('#start');
const stopButton = $('#stop');
const transcript = $('#transcript');
const events = $('#events');
const remoteAudio = $('#remote-audio');
const textForm = $('#text-form');
const textInput = $('#text-input');
const textSubmit = textForm.querySelector('button');

let mode = null;
let peer = null;
let media = null;
let channel = null;
let sessionId = null;
let partialAssistant = '';
let bridgeBusy = false;
let playback = null;

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
      setStatus('error', 'Error', event.error?.message || 'Realtime session error');
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

async function runBridgeText(text) {
  addTurn('user', text);
  setStatus('checking', 'Thinking', 'Codex is preparing a short spoken answer…');
  const result = await api(`api/codex-realtime/${encodeURIComponent(sessionId)}/bridge/turn`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  addTurn('assistant', result.text);
  log('bridge turn', { model: result.model, firstTokenMs: result.firstTokenMs, latencyMs: result.latencyMs });
  setStatus('live', 'Speaking', `${result.model} answered in ${(result.latencyMs / 1000).toFixed(1)}s.`);
  startButton.querySelector('[data-label]').textContent = 'Speaking…';
  playback = newPlayback();
  await speakSmart(result.text, playback);
  setStatus('ready', 'Ready', 'Codex bridge is ready for another turn.');
}

async function bridgeVoiceTurn() {
  if (bridgeBusy) return;
  bridgeBusy = true;
  unlockAudio();
  stopAllPlayback();
  startButton.disabled = true;
  startButton.querySelector('[data-label]').textContent = 'Listening…';
  setStatus('live', 'Listening', 'Speak naturally. The turn ends after a short silence.');
  try {
    // Warm the Codex thread while the operator is speaking so first-turn setup
    // is hidden behind microphone time instead of added after it.
    const session = ensureBridgeSession();
    const recording = recordUntilSilence();
    const [, blob] = await Promise.all([session, recording]);
    setStatus('checking', 'Transcribing', 'Local Whisper is transcribing this turn…');
    const text = await transcribe(blob);
    if (!text) {
      setStatus('ready', 'Ready', 'I did not hear speech. Tap Speak and try again.');
      return;
    }
    await runBridgeText(text);
  } catch (error) {
    log('bridge failed', { code: error.code, message: error.message });
    setStatus('error', 'Unavailable', error.message);
  } finally {
    bridgeBusy = false;
    startButton.disabled = false;
    startButton.querySelector('[data-label]').textContent = 'Speak again';
  }
}

async function startNative() {
  startButton.disabled = true;
  startButton.querySelector('[data-label]').textContent = 'Connecting…';
  setStatus('checking', 'Connecting', 'Requesting microphone access and creating the WebRTC offer…');
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
        setStatus('error', 'Disconnected', 'The realtime peer connection failed.');
      }
    };
    media.getAudioTracks().forEach((track) => peer.addTrack(track, media));
    channel = peer.createDataChannel('oai-events');
    channel.onopen = () => log('data channel open');
    channel.onmessage = (message) => {
      try { handleRealtimeEvent(JSON.parse(message.data)); }
      catch { log('unparsed event'); }
    };
    channel.onerror = () => setStatus('error', 'Channel error', 'The realtime event channel failed.');

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
    setStatus('live', 'Live', `Connected to ${result.voice} over Codex realtime ${result.version}.`);
    log('native session started', { threadId: result.threadId, voice: result.voice, version: result.version });
  } catch (error) {
    log('native start failed', { code: error.code, message: error.message });
    await stop({ remote: false });
    setStatus('error', 'Unavailable', error.message);
  }
}

function renderIdle() {
  if (mode === 'bridge') {
    startButton.disabled = false;
    startButton.querySelector('[data-label]').textContent = 'Speak';
    textInput.disabled = false;
    textSubmit.disabled = false;
    setStatus('ready', 'Ready', 'Codex bridge uses local Whisper and Kokoro with your existing ChatGPT login.');
  } else if (mode === 'native') {
    startButton.disabled = false;
    startButton.querySelector('[data-label]').textContent = 'Start realtime';
    textInput.disabled = true;
    textSubmit.disabled = true;
    setStatus('ready', 'Ready', 'Native Codex realtime is ready.');
  }
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
    mode = result.mode;
    log('capability', {
      mode,
      authType: result.authType,
      nativeReady: result.nativeReady,
      bridgeReady: result.bridgeReady,
    });
    if (!result.ready) {
      setup.hidden = false;
      setupCopy.textContent = result.setup;
      setStatus('blocked', 'Setup needed', 'The installed Codex CLI is not signed in.');
      return;
    }
    setup.hidden = true;
    if (mode === 'native') {
      const voices = result.voices?.v2 || [];
      voiceSelect.replaceChildren(...voices.map((voice) => {
        const option = document.createElement('option');
        option.value = voice;
        option.textContent = voice[0].toUpperCase() + voice.slice(1);
        option.selected = voice === (result.voices.defaultV2 || 'marin');
        return option;
      }));
      voiceSelect.disabled = false;
    } else {
      voiceSelect.replaceChildren(new Option(`Kokoro + ${result.bridgeModel}`, 'bridge', true, true));
      voiceSelect.disabled = true;
    }
    renderIdle();
  } catch (error) {
    log('capability failed', { code: error.code, message: error.message });
    setStatus('error', 'Unavailable', error.message);
  }
}

startButton.addEventListener('click', () => {
  if (mode === 'bridge') bridgeVoiceTurn();
  else if (mode === 'native') startNative();
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
      setStatus('error', 'Send failed', error.message);
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
    setStatus('error', 'Send failed', error.message);
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
