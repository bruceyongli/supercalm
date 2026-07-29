import { enablePush, setPushPreferences } from './common.js';
import { isVoiceModeActive, prepareVoiceMode, startVoiceMode, stopVoiceMode } from './voicemode.js';
import { nextOnTheGoAttention, onTheGoAttentionKey } from './on-the-go-state.js';
export { nextOnTheGoAttention, onTheGoAttentionKey } from './on-the-go-state.js';

// The on-the-go assistant connects three existing reliable paths:
//   foreground Needs You update -> chime -> hands-free voice concierge
//   background/suspended PWA     -> Web Push -> notification tap -> focused concierge
//   spoken reply                 -> the concierge's existing confirm + deliverReply flow
// It deliberately does not pretend a suspended iOS web app can start arbitrary background audio or
// keep a hot microphone. Web Push is the background bridge; automatic speech is a foreground feature.

const ENABLED_KEY = 'aios.on-the-go.enabled';
const ANNOUNCED_KEY = 'aios.on-the-go.announced';
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
function saveAnnounced() {
  try { localStorage.setItem(ANNOUNCED_KEY, JSON.stringify([...announced].slice(-ANNOUNCED_MAX))); } catch {}
}

let enabled = readEnabled();
let announced = readAnnounced();
let currentNeeds = [];
let initialObserved = false;
let talking = false;
let push = 'unknown';
let detail = enabled ? 'Notifications on · voice activates for new foreground updates' : 'Off';
let listeners = new Set();
let chimeContext = null;

const launchParams = new URLSearchParams(location.search);
const notificationLaunch = launchParams.get('on-the-go') === '1' || launchParams.get('ride') === '1';
let pendingFocus = notificationLaunch ? String(launchParams.get('focus') || '') : '';
if (notificationLaunch) {
  enabled = true;
  try { localStorage.setItem(ENABLED_KEY, '1'); } catch {}
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
  return { enabled, talking, push, detail };
}

function emit() {
  const state = onTheGoState();
  document.documentElement.classList.toggle('on-the-go-on', enabled);
  for (const listener of listeners) {
    try { listener(state); } catch {}
  }
  window.dispatchEvent(new CustomEvent('aios:on-the-go', { detail: state }));
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

async function speakNeeds(session, { manual = false } = {}) {
  if (!enabled || talking || voiceAdapter.active?.() || !session || document.hidden) return false;
  // One concierge pass walks the complete current queue, so mark that snapshot together. A skipped
  // report remains visible in Needs You but does not immediately re-trigger another spoken pass.
  markAnnounced(currentNeeds);
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
    if (enabled && !detail.startsWith('Voice could not')) detail = 'Listening for the next Needs You update';
    emit();
    setTimeout(scan, 500);
  }
  return true;
}

function scan({ manual = false } = {}) {
  if (!enabled || talking || voiceAdapter.active?.() || document.hidden) return;
  let next = null;
  if (pendingFocus) {
    next = currentNeeds.find((session) => session.id === pendingFocus) || null;
    if (next) pendingFocus = '';
  }
  if (!next) next = manual ? currentNeeds[0] || null : nextOnTheGoAttention(currentNeeds, announced);
  if (next) speakNeeds(next, { manual });
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
    detail = 'Off';
    try { localStorage.setItem(ENABLED_KEY, '0'); } catch {}
    try { voiceAdapter.stop?.(); } catch {}
    setPushPreferences({ onTheGo: false }).catch(() => {});
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
  const pushOn = await enablePush({ onTheGo: true }).catch(() => false);
  await audioPrime;
  const voice = await voiceAdapter.prepare?.({ requestMic: true })
    .catch((error) => ({ mic: false, error: error?.message || error }));
  push = pushOn ? 'on' : 'unavailable';
  detail = voice?.mic === false
    ? 'Notifications on · microphone permission still needed for replies'
    : pushOn
      ? 'On · speaks in foreground, notifies in background'
      : 'On in foreground · install the PWA to enable background notifications';
  emit();
  scan({ manual: true });
  return onTheGoState();
}

// A normal interaction after restoring the PWA re-unlocks Web Audio without showing a permission
// prompt. This makes a previously enabled on-the-go assistant resilient across page reloads on iOS.
if (enabled) {
  // Refresh an existing subscription's preference after a renamed release without showing prompts.
  setPushPreferences({ onTheGo: true }).catch(() => {});
  window.addEventListener('pointerdown', () => voiceAdapter.prepare?.({ requestMic: false }).catch(() => {}), { once: true, capture: true });
}
window.addEventListener('visibilitychange', () => { if (!document.hidden) scan(); });
window.addEventListener('aios:voice-mode-end', () => { talking = false; setTimeout(scan, 500); });
queueMicrotask(emit);
