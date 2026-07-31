import { enablePush, setPushPreferences } from './common.js';
import { isVoiceModeActive, prepareVoiceMode, startVoiceMode, stopVoiceMode } from './voicemode.js';
import { nextOnTheGoAttention, onTheGoAttentionKey } from './on-the-go-state.js';
export { nextOnTheGoAttention, onTheGoAttentionKey } from './on-the-go-state.js';

// Voice updates connects three existing reliable paths:
//   foreground Needs You update -> chime -> hands-free voice concierge
//   background/suspended PWA     -> Web Push -> notification tap -> focused concierge
//   spoken reply                 -> the concierge's existing confirm + deliverReply flow
// It deliberately does not pretend a suspended iOS web app can start arbitrary background audio or
// keep a hot microphone. Web Push is the background bridge; automatic speech is a foreground feature.

const ENABLED_KEY = 'aios.on-the-go.enabled';
const ANNOUNCED_KEY = 'aios.on-the-go.announced';
const STYLE_KEY = 'aios.voice-updates.style';
const ANNOUNCED_MAX = 120;

function readEnabled() {
  try {
    const current = localStorage.getItem(ENABLED_KEY);
    if (current != null) return current === '1';
    // One-release migration for devices that enabled the original bicycle-specific label.
    const legacy = localStorage.getItem('aios.ride.enabled');
    if (legacy != null) localStorage.setItem(ENABLED_KEY, legacy);
    return legacy === '1';
  } catch { return false; }
}
function readAnnounced() {
  try {
    const raw = localStorage.getItem(ANNOUNCED_KEY) ?? localStorage.getItem('aios.ride.announced') ?? '[]';
    const values = JSON.parse(raw);
    return new Set(Array.isArray(values) ? values.slice(-ANNOUNCED_MAX) : []);
  } catch { return new Set(); }
}
function readStyle(wasEnabled) {
  try {
    const saved = localStorage.getItem(STYLE_KEY);
    if (saved === 'call' || saved === 'walkie') return saved;
    // Preserve automatic speech on devices that enabled Voice updates before this choice existed.
    // Fresh devices start with the less intrusive incoming-call style.
    return wasEnabled ? 'walkie' : 'call';
  } catch { return 'call'; }
}
function saveAnnounced() {
  try { localStorage.setItem(ANNOUNCED_KEY, JSON.stringify([...announced].slice(-ANNOUNCED_MAX))); } catch {}
}

let enabled = readEnabled();
let style = readStyle(enabled);
let announced = readAnnounced();
let currentNeeds = [];
let initialObserved = false;
let talking = false;
let incoming = null;
let push = 'unknown';
let detail = enabled ? `Voice updates on · ${style === 'call' ? 'asks before talking' : 'speaks new reports'}` : 'Off';
let listeners = new Set();
let chimeContext = null;
let ringTimer = null;

const launchParams = new URLSearchParams(location.search);
const notificationLaunch = launchParams.get('on-the-go') === '1' || launchParams.get('ride') === '1';
const callLaunch = launchParams.get('voice-call');
let pendingFocus = notificationLaunch || callLaunch ? String(launchParams.get('focus') || '') : '';
let acceptNotificationCall = callLaunch === 'accept';
if (notificationLaunch || callLaunch) {
  enabled = true;
  style = callLaunch ? 'call' : 'walkie';
  try { localStorage.setItem(ENABLED_KEY, '1'); } catch {}
  try { localStorage.setItem(STYLE_KEY, style); } catch {}
}

let voiceAdapter = {
  active: isVoiceModeActive,
  prepare: prepareVoiceMode,
  start: startVoiceMode,
  stop: stopVoiceMode,
};

export function setOnTheGoVoiceAdapter(adapter = {}) {
  voiceAdapter = { ...voiceAdapter, ...adapter };
}

export function onTheGoState() {
  return {
    enabled,
    talking,
    style,
    incoming: incoming ? {
      id: incoming.id,
      project: incoming.project || incoming.title || 'Project update',
      summary: incoming.summary || incoming.question || incoming.title || 'A new update needs your attention.',
    } : null,
    detail,
  };
}

function emit() {
  const state = onTheGoState();
  document.documentElement.classList.toggle('on-the-go-on', enabled);
  renderIncomingCall();
  for (const listener of listeners) {
    try { listener(state); } catch {}
  }
  window.dispatchEvent(new CustomEvent('aios:on-the-go', { detail: state }));
}

function stopRinging() {
  clearInterval(ringTimer);
  ringTimer = null;
}

function renderIncomingCall() {
  let layer = document.querySelector('[data-voice-update-call]');
  if (!incoming || !enabled || style !== 'call') {
    layer?.remove();
    return;
  }
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'voice-update-call';
    layer.dataset.voiceUpdateCall = '';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-labelledby', 'voice-update-call-title');
    layer.innerHTML = `
      <div class="voice-update-call-card">
        <div class="voice-update-call-signal" aria-hidden="true"><i></i></div>
        <div class="voice-update-call-kicker">VOICE ASSISTANT · INCOMING UPDATE</div>
        <h2 id="voice-update-call-title"></h2>
        <p></p>
        <div class="voice-update-call-actions">
          <button type="button" class="later" data-voice-call-decline>Not now</button>
          <button type="button" class="answer" data-voice-call-accept>Accept</button>
        </div>
        <small>Not now silences this update. It stays in Needs You.</small>
      </div>`;
    layer.querySelector('[data-voice-call-accept]').onclick = acceptVoiceUpdate;
    layer.querySelector('[data-voice-call-decline]').onclick = declineVoiceUpdate;
    document.body.append(layer);
  }
  layer.querySelector('h2').textContent = incoming.project || incoming.title || 'Project update';
  layer.querySelector('p').textContent = incoming.summary || incoming.question || incoming.title || 'A new update needs your attention.';
}

export function subscribeOnTheGo(listener) {
  listeners.add(listener);
  try { listener(onTheGoState()); } catch {}
  return () => listeners.delete(listener);
}

function markAnnounced(needs) {
  for (const session of needs || []) {
    const key = onTheGoAttentionKey(session);
    if (key) announced.add(key);
  }
  while (announced.size > ANNOUNCED_MAX) announced.delete(announced.values().next().value);
  saveAnnounced();
}

async function chime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    chimeContext = chimeContext || new AC();
    if (chimeContext.state !== 'running') await chimeContext.resume();
    const start = chimeContext.currentTime;
    for (const [offset, frequency] of [[0, 660], [0.14, 880]]) {
      const oscillator = chimeContext.createOscillator();
      const gain = chimeContext.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.08, start + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.12);
      oscillator.connect(gain).connect(chimeContext.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.14);
    }
    await new Promise((resolve) => setTimeout(resolve, 320));
  } catch {}
}

function offerCall(session) {
  if (!enabled || style !== 'call' || talking || voiceAdapter.active?.() || !session || document.hidden) return false;
  const key = onTheGoAttentionKey(session);
  if (incoming && onTheGoAttentionKey(incoming) === key) return true;
  incoming = session;
  detail = `Incoming update from ${session.project || session.title || 'a project'}`;
  emit();
  stopRinging();
  void chime();
  ringTimer = setInterval(() => { if (incoming && !document.hidden) void chime(); }, 5000);
  return true;
}

export async function acceptVoiceUpdate() {
  const session = incoming;
  if (!session) return false;
  stopRinging();
  incoming = null;
  emit();
  return speakNeeds(session, { manual: true });
}

export function declineVoiceUpdate() {
  if (!incoming) return false;
  // One call offers a guided pass over the current queue. "Not now" silences that snapshot without
  // changing Needs You or its cross-device dismissal state; only a genuinely new report can ring.
  markAnnounced(currentNeeds);
  stopRinging();
  incoming = null;
  detail = 'Call declined · Needs You is unchanged';
  emit();
  return true;
}

async function speakNeeds(session, { manual = false } = {}) {
  if (!enabled || talking || voiceAdapter.active?.() || !session || document.hidden) return false;
  // One concierge pass walks the complete current queue, so mark that snapshot together. A skipped
  // report remains visible in Needs You but does not immediately re-trigger another spoken pass.
  markAnnounced(currentNeeds);
  stopRinging();
  incoming = null;
  talking = true;
  detail = `Talking about ${session.project || session.title || 'a project'}…`;
  emit();
  if (!manual) await chime();
  try {
    await voiceAdapter.start?.({ focusSessionId: session.id, source: manual ? 'on-the-go-enable' : 'on-the-go-update' });
  } catch (error) {
    detail = `Voice could not start · ${error?.message || error}`;
  } finally {
    talking = false;
    if (enabled && !detail.startsWith('Voice could not')) detail = 'Voice updates on · waiting for the next Needs You report';
    emit();
    setTimeout(scan, 500);
  }
  return true;
}

function scan({ manual = false } = {}) {
  if (!enabled || talking || incoming || voiceAdapter.active?.() || document.hidden) return;
  let next = null;
  if (pendingFocus) {
    next = currentNeeds.find((session) => session.id === pendingFocus) || null;
    if (next) pendingFocus = '';
  }
  if (!next) next = manual ? currentNeeds[0] || null : nextOnTheGoAttention(currentNeeds, announced);
  if (!next) return;
  if (style === 'call' && !manual && !acceptNotificationCall) offerCall(next);
  else {
    acceptNotificationCall = false;
    speakNeeds(next, { manual: true });
  }
}

export function observeOnTheGoNeeds(needs) {
  currentNeeds = (needs || []).filter(Boolean);
  try {
    if ('setAppBadge' in navigator) {
      currentNeeds.length ? navigator.setAppBadge(currentNeeds.length).catch(() => {}) : navigator.clearAppBadge?.().catch(() => {});
    }
  } catch {}

  if (!initialObserved) {
    initialObserved = true;
    // A normal app launch establishes a baseline instead of suddenly reading yesterday's queue.
    // Once the on-the-go assistant is enabled, persisted report keys survive reloads so an update
    // while this page was gone is still announced. A notification launch carries `focus`, so that
    // exact report is always allowed through as well.
    if (!enabled && !pendingFocus) markAnnounced(currentNeeds);
  }
  scan();
}

export async function toggleOnTheGo() {
  if (enabled) {
    enabled = false;
    talking = false;
    stopRinging();
    incoming = null;
    detail = 'Off';
    try { localStorage.setItem(ENABLED_KEY, '0'); } catch {}
    try { voiceAdapter.stop?.(); } catch {}
    setPushPreferences({ onTheGo: false, voiceStyle: style }).catch(() => {});
    emit();
    return onTheGoState();
  }

  enabled = true;
  detail = 'Enabling notifications and microphone…';
  try { localStorage.setItem(ENABLED_KEY, '1'); } catch {}
  emit();

  // Unlock audio and start Notification.requestPermission in the button's activation turn. Ask for
  // microphone access after the notification prompt settles so iOS never has two system permission
  // sheets competing at once (getUserMedia permission does not require the same transient activation).
  const audioPrime = voiceAdapter.prepare?.({ requestMic: false }).catch(() => null);
  const pushOn = await enablePush({ onTheGo: true, voiceStyle: style }).catch(() => false);
  await audioPrime;
  const voice = await voiceAdapter.prepare?.({ requestMic: true })
    .catch((error) => ({ mic: false, error: error?.message || error }));
  push = pushOn ? 'on' : 'unavailable';
  detail = voice?.mic === false
    ? 'Notifications on · microphone permission still needed for replies'
    : pushOn
      ? `Voice updates on · ${style === 'call' ? 'asks before talking' : 'speaks new reports'} and notifies in background`
      : `Voice updates on in foreground · ${style === 'call' ? 'asks before talking' : 'speaks new reports'}`;
  emit();
  const current = currentNeeds[0] || null;
  if (style === 'call' && current) offerCall(current);
  else scan({ manual: true });
  return onTheGoState();
}

export function setVoiceUpdateStyle(nextStyle) {
  const next = nextStyle === 'walkie' ? 'walkie' : 'call';
  if (next === style) return onTheGoState();
  style = next;
  try { localStorage.setItem(STYLE_KEY, style); } catch {}
  stopRinging();
  const offered = incoming;
  incoming = null;
  detail = enabled
    ? `Voice updates on · ${style === 'call' ? 'asks before talking' : 'speaks new reports'}`
    : 'Off';
  if (enabled) setPushPreferences({ onTheGo: true, voiceStyle: style }).catch(() => {});
  emit();
  // Switching an unanswered incoming call to walkie-talkie means "tell me now"; otherwise this
  // setting affects the next genuinely new report without inventing a duplicate update.
  if (enabled && style === 'walkie' && offered) speakNeeds(offered, { manual: true });
  return onTheGoState();
}

// A normal interaction after restoring the PWA re-unlocks Web Audio without showing a permission
// prompt. This makes a previously enabled on-the-go assistant resilient across page reloads on iOS.
if (enabled) {
  // Refresh an existing subscription's preference after a renamed release without showing prompts.
  setPushPreferences({ onTheGo: true, voiceStyle: style }).catch(() => {});
  window.addEventListener('pointerdown', () => voiceAdapter.prepare?.({ requestMic: false }).catch(() => {}), { once: true, capture: true });
}
window.addEventListener('visibilitychange', () => {
  if (document.hidden) stopRinging();
  else {
    if (incoming) { void chime(); ringTimer = setInterval(() => { if (incoming && !document.hidden) void chime(); }, 5000); }
    else scan();
  }
});
window.addEventListener('aios:voice-mode-end', () => { talking = false; setTimeout(scan, 500); });
queueMicrotask(emit);
