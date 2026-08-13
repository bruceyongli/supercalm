// Voice-mode visual check (operator 2026-08-12: "in voice mode it's really hard to understand …
// did it actually change the …? I want a button with preview … a screenshot of desktop or iPad or
// phone view … the images are usually already in the session log … automatically prepared for me
// to just click and see what's going on and give a response").
//
// Two image sources, assembled into one manifest per session:
//   1. Session-log images — screenshots the agent itself already produced: files in the session's
//      artifacts dir, supervisor evidence shots, and image paths mentioned in the recent terminal/
//      messages (approved through the same resolveSessionFile scope as the file viewer).
//   2. Fresh viewport shots — when the session has a configured preview URL (supervisor config /
//      preview profiles / the project's release target live_url), ONE headless-chrome run captures
//      desktop + tablet + phone via CDP device emulation into the shared supervisor shot dir.
// The voice loop pre-captures on item advance (fire-and-forget), so by the time the operator taps
// Preview the shots are already on disk. All bytes are served through EXISTING safe routes
// (/api/session/:id/shot/:file and /api/session/:id/file) plus one artifacts route here.
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, normalize } from 'node:path';
import { route, json } from './server.js';
import { DATA_DIR } from './config.js';
import * as store from './store.js';
import { sessionStoragePaths } from './session_storage.js';
import { resolveSessionFile } from './sessions.js';
import { capturePreview, terminalTail } from './agents/evidence.js';
import { activePreviewProfiles } from './preview_profiles.js';
import { getTarget } from './release_monitor.js';

const SHOT_DIR = join(DATA_DIR, 'supervisor');
const IMAGE_RX = /\.(png|jpe?g|webp|gif)$/i;
const SHOT_TTL_MS = Number(process.env.AIOS_VOICE_SHOT_TTL_MS || 180000); // reuse fresh shots ~3min
const VIEWPORTS = [
  { key: 'desktop', width: 1440, height: 900, mobile: false, scale: 1 },
  { key: 'tablet', width: 834, height: 1112, mobile: true, scale: 2 },
  { key: 'phone', width: 390, height: 844, mobile: true, scale: 2 },
];
const VOICE_SHOT_RX = /^voice-(desktop|tablet|phone)-(\d+)\.png$/;

// The URL this session's app can be seen at: supervisor preview profiles → supervisor preview_url →
// the project's release-target live URL. Null when nothing is configured (log images still work).
export function previewTargetFor(session) {
  try {
    const cfg = store.getGrant(session.id, 'supervisor')?.config || {};
    const profiles = activePreviewProfiles({ preview_profiles: cfg.preview_profiles || [] });
    if (profiles.length) {
      const p = profiles[0];
      return { url: p.url, auth: p.passcode_gated && p.passcode ? { username: p.username || '', passcode: p.passcode } : null };
    }
    if (cfg.preview_url) return { url: cfg.preview_url, auth: null };
    const t = session.project_id ? getTarget(session.project_id) : null;
    if (t?.live_url) return { url: t.live_url, auth: null };
  } catch {}
  return null;
}

export async function listViewportShots(sessionId) {
  const dir = join(SHOT_DIR, sessionId);
  const byKey = new Map();
  try {
    for (const f of await readdir(dir)) {
      const m = VOICE_SHOT_RX.exec(f);
      if (!m) continue;
      const ts = Number(m[2]);
      const cur = byKey.get(m[1]);
      if (!cur || ts > cur.ts) byKey.set(m[1], { key: m[1], file: f, ts });
    }
  } catch {}
  return VIEWPORTS.map((v) => byKey.get(v.key)).filter(Boolean)
    .map((s) => ({ key: s.key, ts: s.ts, url: `api/session/${encodeURIComponent(sessionId)}/shot/${encodeURIComponent(s.file)}` }));
}

// One capture in flight per session; a fresh-enough set short-circuits. Fire-and-forget safe.
const inflight = new Map();
export function prepareVoicePreview(sessionId) {
  if (inflight.has(sessionId)) return inflight.get(sessionId);
  const p = (async () => {
    const session = store.getSession(sessionId);
    if (!session) return null;
    const target = previewTargetFor(session);
    if (!target) return null;
    const have = await listViewportShots(sessionId);
    const freshest = Math.min(...VIEWPORTS.map((v) => have.find((s) => s.key === v.key)?.ts || 0));
    if (freshest && Date.now() - freshest < SHOT_TTL_MS) return have; // full fresh set — reuse
    await capturePreview(sessionId, target.url, target.auth, { viewports: VIEWPORTS, filePrefix: 'voice-' });
    return listViewportShots(sessionId);
  })().catch((e) => {
    console.error('[aios] voice preview capture failed:', String(e.message || e).slice(0, 160));
    return null;
  }).finally(() => setTimeout(() => inflight.delete(sessionId), 400));
  inflight.set(sessionId, p);
  return p;
}

async function newestImagesIn(dir, limit) {
  const items = [];
  try {
    for (const f of await readdir(dir)) {
      if (!IMAGE_RX.test(f)) continue;
      try {
        const st = await stat(join(dir, f));
        if (st.isFile() && st.size > 0) items.push({ file: f, ts: st.mtimeMs });
      } catch {}
    }
  } catch {}
  return items.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

// Image paths the agent mentioned in the recent terminal/messages — the "images already in the
// session log". Approval goes through resolveSessionFile (same scope as the file viewer), so this
// can never read outside the session's approved roots.
async function logMentionedImages(session, limit) {
  let text = '';
  try { text = await terminalTail(session.id, 12000); } catch {}
  try { text += '\n' + store.recentMessagesFor(session.id, 30).map((m) => String(m.text || '')).join('\n'); } catch {}
  const rx = /(?:^|[\s"'`(=[])((?:\.{0,2}\/)?[\w@%+.~/-]*?[\w@%+-]\.(?:png|jpe?g|webp|gif))(?=$|[\s"'`)\],:;])/gim;
  const seen = new Set();
  const candidates = [];
  for (const m of text.matchAll(rx)) {
    const p = m[1];
    if (p.startsWith('~') || seen.has(p)) continue;
    seen.add(p);
    candidates.push(p);
  }
  const out = [];
  for (const rel of candidates.reverse().slice(0, 14)) { // newest mentions live at the tail
    if (out.length >= limit) break;
    try {
      const resolved = await resolveSessionFile(session, rel);
      if (!resolved?.target) continue;
      const st = await stat(resolved.target).catch(() => null);
      if (!st?.isFile() || !st.size) continue;
      out.push({
        label: basename(resolved.target),
        source: 'log',
        ts: st.mtimeMs,
        url: `api/session/${encodeURIComponent(session.id)}/file?path=${encodeURIComponent(rel)}&raw=1`,
      });
    } catch {}
  }
  return out;
}

export async function collectLogImages(session, limit = 8) {
  const images = [];
  const paths = sessionStoragePaths(session.id);
  for (const s of await newestImagesIn(paths.artifacts, limit)) {
    images.push({ label: s.file, source: 'artifact', ts: s.ts, url: `api/session/${encodeURIComponent(session.id)}/voice-preview/artifact/${encodeURIComponent(s.file)}` });
  }
  for (const s of await newestImagesIn(join(SHOT_DIR, session.id), limit)) {
    if (VOICE_SHOT_RX.test(s.file) || /^voice-/.test(s.file)) continue; // viewport set is listed separately
    images.push({ label: 'supervisor check', source: 'supervisor', ts: s.ts, url: `api/session/${encodeURIComponent(session.id)}/shot/${encodeURIComponent(s.file)}` });
  }
  images.push(...await logMentionedImages(session, limit));
  return images.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

// Manifest the voice overlay's Preview button renders from. `?prepare=1` kicks a background capture
// so a tap that arrives before the loop's own pre-capture still warms the set.
route('GET', '/api/session/:id/voice-preview', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  const u = new URL(req.url, 'http://x');
  const target = previewTargetFor(s);
  if (u.searchParams.get('prepare') === '1' && target) prepareVoicePreview(sid);
  json(res, 200, {
    previewUrl: target?.url || '',
    preparing: inflight.has(sid),
    viewports: await listViewportShots(sid),
    logImages: await collectLogImages(s, 8),
  });
});

// Session artifacts are outside the project root (data/session-artifacts/<sid>/) so the file viewer
// cannot serve them; this is the one purpose-built byte route, with the same containment shape as
// the supervisor shot route.
route('GET', '/api/session/:id/voice-preview/artifact/:file', async (req, res, { id: sid, file }) => {
  if (!store.getSession(sid)) return json(res, 404, { error: 'no such session' });
  const name = basename(String(file || ''));
  if (!name || !IMAGE_RX.test(name)) return json(res, 400, { error: 'bad image name' });
  const dir = normalize(sessionStoragePaths(sid).artifacts);
  const target = normalize(join(dir, name));
  if (!target.startsWith(dir + '/')) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(target);
    const ext = extname(name).toLowerCase();
    const type = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=300' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'image not found' });
  }
});
