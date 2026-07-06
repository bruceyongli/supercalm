import webpush from 'web-push';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';
import { route, json, readJson } from './server.js';
import * as store from './store.js';
import { bus } from './bus.js';

// VAPID keys persist across restarts so existing subscriptions stay valid.
const VAPID_PATH = join(DATA_DIR, '.vapid.json');
let vapid;
if (existsSync(VAPID_PATH)) {
  vapid = JSON.parse(readFileSync(VAPID_PATH, 'utf8'));
} else {
  vapid = webpush.generateVAPIDKeys();
  writeFileSync(VAPID_PATH, JSON.stringify(vapid), { mode: 0o600 });
  console.log('[aios] generated VAPID keys');
}
// VAPID subject: a contact URI push services can reach you at. Set AIOS_PUSH_SUBJECT to your own
// mailto:/https: value; the default is a neutral placeholder (web-push only requires a valid URI).
webpush.setVapidDetails(process.env.AIOS_PUSH_SUBJECT || 'mailto:aios@example.com', vapid.publicKey, vapid.privateKey);

route('GET', '/api/vapidPublicKey', (req, res) => json(res, 200, { key: vapid.publicKey }));

route('POST', '/api/subscribe', async (req, res) => {
  const sub = await readJson(req).catch(() => null);
  if (!sub || !sub.endpoint) return json(res, 400, { error: 'invalid subscription' });
  store.addSub(sub);
  json(res, 201, { ok: true });
});

route('POST', '/api/unsubscribe', async (req, res) => {
  const b = await readJson(req).catch(() => ({}));
  if (b.endpoint) store.removeSub(b.endpoint);
  json(res, 200, { ok: true });
});

async function pushAll(payload) {
  const subs = store.listSubs();
  if (!subs.length) return;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 600, urgency: 'high' });
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) store.removeSub(sub.endpoint); // gone
        else console.error('[aios] push error', e.statusCode || e.message);
      }
    })
  );
}

// Generic operator notification — for code that wants to alert devices outside the poll-loop
// 'waiting' path (e.g. the supervisor on verified-complete or an escalation). Title/body bounded;
// `url` is relative (the SW resolves it against /aios/), `tag` collapses repeats for one session.
export function notify(title, body, url = '.', tag = 'aios') {
  return pushAll({
    title: String(title || 'Supercalm').replace(/\s+/g, ' ').slice(0, 90),
    body: String(body || '').replace(/\s+/g, ' ').slice(0, 140),
    url,
    tag,
  }).catch(() => {});
}

// A session just transitioned to "waiting" (with an LLM summary) -> alert devices.
const CAT_TAG = { action: 'action needed', decision: 'decision needed', review: 'ready for review', working: 'working' };
bus.on('waiting', ({ session, summary, category }) => {
  if (category === 'working') return; // LLM judged it not actually waiting on you
  const s = store.getSession(session);
  if (!s) return;
  const project = s.project_id ? store.getProject(s.project_id) : null;
  pushAll({
    title: `${project ? project.name : s.tool} · ${CAT_TAG[category] || 'needs you'}`,
    body: String(summary || s.summary || s.title || 'Waiting for input').replace(/\s+/g, ' ').slice(0, 140),
    url: `session?id=${session}`, // relative — the SW resolves it against its scope (/aios/)
    tag: session,
  }).catch(() => {});
});

// Decoupled notification channel: any module can `bus.emit('notify', {title, body, url, tag})`
// without importing push.js (avoids cycles). The supervisor uses this for verified-complete +
// escalations. Mirrors the bus.on('waiting') pattern above.
bus.on('notify', ({ title, body, url, tag } = {}) => {
  notify(title, body, url || '.', tag || 'aios');
});

// Let a device fire a test notification to itself.
route('POST', '/api/push/test', async (req, res) => {
  await pushAll({ title: 'Supercalm test', body: 'Push notifications are working.', url: '.', tag: 'test' });
  json(res, 200, { ok: true, subs: store.listSubs().length });
});

console.log('[aios] web-push ready');
