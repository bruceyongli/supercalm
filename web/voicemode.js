import { api, createLiveSpeechRecognizer, rememberSpeechLanguage } from './common.js';
import { unlockAudio as unlockPlayer, newPlayback, stopAllPlayback, speakSmart, applyRateLive } from './tts-player.js';

// Hands-free voice concierge loop:
//   speak (TTS) -> [listen with VAD -> STT -> /turn]  OR  [/continue] -> speak -> ...
// until the server says done or the user taps Stop / says "stop".
// TTS synthesis + playback is the SHARED tts-player.js stack (one stack for story-view + concierge +
// phone); this module owns the concierge LOOP, the overlay UI, VAD/STT, and the device-voice picker.
let active = false,
  stopFlag = false,
  voiceId = null,
  handle = null, // current tts-player playback handle (for stop)
  ui = null;

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
    const AC = window.AudioContext || window.webkitAudioContext;
    vadCtx = vadCtx || new AC();
    if (vadCtx.state !== 'running') vadCtx.resume().catch(() => {});
  } catch {}
}

export async function startVoiceMode() {
  if (active) return;
  active = true;
  stopFlag = false;
  unlockAudio(); // MUST run synchronously in the tap gesture, before any await, to unlock iOS audio
  ui = buildOverlay();
  try {
    let state = await post('api/voice/start', {});
    voiceId = state.voiceId;
    while (!stopFlag) {
      if (state.current) updateProgress(state.current);
      if (state.done && ui) ui.bar.style.width = '100%';
      setState('speaking', state.say);
      await speak(state.say);
      if (state.done || stopFlag) break;
      if (state.listen) {
        setState('listening');
        let text = '';
        let live = null;
        try {
          live = createLiveSpeechRecognizer({
            onUpdate: (heard) => {
              if (ui?.heard && heard) ui.heard.textContent = '“' + heard + '”';
            },
          });
          live.start();
          const blob = await recordUntilSilence();
          if (stopFlag) break;
          live.stop();
          setState('thinking');
          text = (await transcribe(blob, state.current?.tool)) || live.getText();
        } catch (e) {
          // Mic permission/device failures would otherwise loop forever: capture fails instantly,
          // an empty turn is posted, the server politely re-asks, repeat. Name the cause and stop.
          if (/NotAllowed|PermissionDenied|NotFound|NotReadable|Security/i.test(e?.name || '')) {
            setState('error', 'Microphone blocked — allow mic access for this site, then tap Voice again.');
            await sleep(2800);
            break;
          }
        } finally {
          live?.abort();
        }
        if (text && ui?.heard) ui.heard.textContent = '“' + text + '”';
        state = await post('api/voice/turn', { voiceId, userText: text });
      } else {
        setState('thinking');
        state = await post('api/voice/continue', { voiceId });
      }
    }
  } catch (e) {
    setState('error', 'Voice mode error: ' + (e.message || e));
    await sleep(1800);
  } finally {
    end();
  }
}

function post(path, body, ms = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms); // a hung /turn or /continue must not freeze the loop
  return api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function end() {
  stopFlag = true;
  active = false;
  if (voiceId) post('api/voice/stop', { voiceId }).catch(() => {});
  voiceId = null;
  try { handle?.stop(); } catch {}
  try { stopAllPlayback(); } catch {} // halt any tts-player playback (belt for the shared element)
  if (ui) { ui.root.remove(); ui = null; }
}

// ---- TTS: two modes ----
// 'neural' (DEFAULT): Spark server TTS. English defaults to Kokoro realtime TTS; Qwen is still available
//   through the server env/request options. The client pipelines per sentence so longer reports
//   can start playing while the next sentence is being generated.
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
function showTtsNotice(message, { offerDevice = false } = {}) {
  if (!ui?.ttsNotice) return;
  ui.ttsNotice.hidden = false;
  ui.ttsNotice.textContent = message;
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
  const rate = ttsRate();
  ui.speed.innerHTML = TTS_RATE_PRESETS.map((r) => `<button class="vm-speed-btn ${r === rate ? 'on' : ''}" data-rate="${r}" type="button">${r === 1 ? '1x' : r + 'x'}</button>`).join('');
  ui.speed.querySelectorAll('[data-rate]').forEach((btn) => {
    btn.onclick = () => setTtsRate(Number(btn.dataset.rate));
  });
  if (ui.mode) ui.mode.textContent = ttsMode() === 'browser' ? 'Device voice fallback' : 'Spark Kokoro voice';
  if (ui.deviceVoice) ui.deviceVoice.textContent = ttsMode() === 'browser' ? 'Use Spark voice' : 'Use device voice';
}
// Speak one line through the SHARED tts-player stack (stream → single → device voice), honoring the
// user's engine pref (aios_tts). The concierge-specific overlay notices ride on tts-player's callbacks.
async function speak(text) {
  if (!text || stopFlag) return;
  if (ttsMode() === 'browser') showTtsNotice('Using your device voice. Switch back to Spark Kokoro when the network is better.', { offerDevice: true });
  else clearTtsNotice();
  handle = newPlayback();
  await speakSmart(text, handle, {
    onSlow: () => showTtsNotice('Spark voice is taking longer than usual. You can switch this conversation to your device voice.', { offerDevice: true }),
    onFallback: () => showTtsNotice('Spark voice is slow or unreachable, so this line is using your device voice. You can switch the rest too.', { offerDevice: true }),
  });
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

// Sentence-ish chunks, merging tiny fragments so each chunk is worth a TTS round-trip.

// ---- STT ----
// agentHint (the current queue item's agent) matches dictation to that session's STT source server-side.
async function transcribe(blob, agentHint) {
  if (!blob || blob.size < 1200) return '';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000); // never let STT wedge the loop
  try {
    const q = agentHint ? `&agent=${encodeURIComponent(agentHint)}` : '';
    const r = await fetch('api/transcribe?language=auto&polish=false' + q, { method: 'POST', headers: { 'content-type': blob.type }, body: blob, signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (r.ok) rememberSpeechLanguage(j.language);
    return r.ok ? (j.text || '').trim() : '';
  } catch {
    return ''; // timeout/abort/network -> empty -> server re-asks, loop continues
  } finally {
    clearTimeout(t);
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
// cause and stops instead of nagging forever. Everything after acquisition is try/finally so a
// constructor failure can never leak the mic.
async function recordUntilSilence({ maxMs = 90000, silenceMs = 1800, graceMs = 8000 } = {}) {
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
        if (stopFlag) return resolve();
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
        if (rms > 0.045) { lastVoice = t; spoke = true; }
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

// ---- overlay UI ----
function buildOverlay() {
  const root = document.createElement('div');
  root.className = 'vm';
  root.innerHTML =
    '<div class="vm-box">' +
    '<div class="vm-progress"><div class="vm-bar"><i></i></div><div class="vm-prog-label"></div></div>' +
    '<div class="vm-orb"></div>' +
    '<div class="vm-state">Starting…</div>' +
    '<div class="vm-said"></div>' +
    '<div class="vm-heard"></div>' +
    '<div class="vm-controls">' +
    '<span class="vm-mode"></span>' +
    '<div class="vm-speed" role="group" aria-label="Speech speed"></div>' +
    '<button class="btn ghost sm vm-device-voice" type="button" hidden>Use device voice</button>' +
    '</div>' +
    '<div class="vm-tts-notice" hidden></div>' +
    '<button class="btn danger vm-stop">Stop</button>' +
    '</div>';
  document.body.appendChild(root);
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
  };
  root.querySelector('.vm-stop').onclick = end;
  o.deviceVoice.onclick = () => {
    if (ttsMode() === 'browser') {
      setTtsMode('neural');
      showTtsNotice('Trying Spark Kokoro voice again for the next response.', { offerDevice: true });
    } else {
      setTtsMode('browser');
      showTtsNotice('Using your device voice for the rest of this voice conversation.', { offerDevice: true });
    }
  };
  renderVoiceControls();
  if (ttsMode() === 'browser') showTtsNotice('Using your device voice fallback. You can switch back to Spark Kokoro when the network is better.', { offerDevice: true });
  return o;
}
function updateProgress(cur) {
  if (!ui || !cur || !cur.total) return;
  ui.prog.textContent = `Item ${cur.n} of ${cur.total}`;
  ui.bar.style.width = Math.round(((cur.n - 1) / cur.total) * 100) + '%';
}
function setState(s, said) {
  if (!ui) return;
  ui.root.dataset.state = s;
  ui.state.textContent = { speaking: 'Speaking…', listening: 'Listening…', thinking: 'Thinking…', error: 'Error' }[s] || s;
  if (said != null) {
    ui.said.textContent = said;
    ui.heard.textContent = '';
  }
}
