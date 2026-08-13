// Voice-mode visual check — locks the 2026-08-12 feature: "in voice mode it's hard to tell whether
// it actually changed anything — I want a Preview button with screenshots (desktop/iPad/phone),
// automatically prepared; the images are usually already in the session log." previewTargetFor
// resolves where the session's app can be seen; collectLogImages gathers images the agent already
// produced (artifacts, supervisor shots, terminal/message-mentioned paths — path-approved);
// listViewportShots exposes the freshest voice-* viewport captures; the voice loop pre-captures on
// item advance so the tap is instant.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-voice-preview-'));
process.env.AIOS_NO_LISTEN = '1'; // voice_preview → sessions.js → server.js: import without binding the port

const store = await import('../src/store.js');
const { setTarget } = await import('../src/release_monitor.js');
const { previewTargetFor, collectLogImages, listViewportShots } = await import('../src/voice_preview.js');

const projRoot = await mkdtemp(join(tmpdir(), 'aios-voice-preview-repo-'));
store.createProject({ id: 'p_vp', name: 'Preview Fixture', path: projRoot });
store.createSession({ id: 's_vp', project_id: 'p_vp', tool: 'codex', tmux: 'aios-vp', title: 'voice preview test', status: 'waiting' });
const session = store.getSession('s_vp');

// ---- previewTargetFor: nothing configured → null; release-target live_url → used; supervisor
// preview_url (per-session) wins over the project-level live URL.
assert.equal(previewTargetFor(session), null);
setTarget('p_vp', { live_url: 'https://live.example.test/app' });
assert.equal(previewTargetFor(session)?.url, 'https://live.example.test/app');
store.upsertGrant('s_vp', 'supervisor', { config: { preview_url: 'http://127.0.0.1:5173/' } });
assert.equal(previewTargetFor(session)?.url, 'http://127.0.0.1:5173/');

// ---- collectLogImages: artifacts + supervisor shots + terminal/message-mentioned paths.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // enough bytes to count as a file
const artifacts = join(process.env.AIOS_DATA, 'session-artifacts', 's_vp');
await mkdir(artifacts, { recursive: true });
await writeFile(join(artifacts, 'qa-final.png'), PNG);
const shotDir = join(process.env.AIOS_DATA, 'supervisor', 's_vp');
await mkdir(shotDir, { recursive: true });
await writeFile(join(shotDir, '1700000000000.png'), PNG); // plain supervisor evidence shot
await writeFile(join(shotDir, 'voice-desktop-1700000000001.png'), PNG); // viewport set — NOT a log image
await mkdir(join(projRoot, 'shots'), { recursive: true });
await writeFile(join(projRoot, 'shots', 'after-fix.png'), PNG);
store.addMessage('s_vp', 'out', 'transcript', 'Saved the screenshot to shots/after-fix.png for review.');

const images = await collectLogImages(session, 8);
const sources = images.map((i) => i.source).sort();
assert.deepEqual(sources, ['artifact', 'log', 'supervisor'], `one image per source, viewport shots excluded (got ${JSON.stringify(images)})`);
const logImg = images.find((i) => i.source === 'log');
assert.match(logImg.url, /api\/session\/s_vp\/file\?path=shots%2Fafter-fix\.png&raw=1/, 'log images serve through the approved file viewer route');
const artifactImg = images.find((i) => i.source === 'artifact');
assert.match(artifactImg.url, /api\/session\/s_vp\/voice-preview\/artifact\/qa-final\.png/, 'artifacts serve through the contained artifact route');

// ---- listViewportShots: newest file per viewport, served via the existing shot route.
await writeFile(join(shotDir, 'voice-desktop-1700000000009.png'), PNG);
await writeFile(join(shotDir, 'voice-tablet-1700000000002.png'), PNG);
await writeFile(join(shotDir, 'voice-phone-1700000000003.png'), PNG);
const vps = await listViewportShots('s_vp');
assert.deepEqual(vps.map((v) => v.key), ['desktop', 'tablet', 'phone']);
assert.match(vps[0].url, /api\/session\/s_vp\/shot\/voice-desktop-1700000000009\.png/, 'the newest desktop capture wins');

// ---- wiring pins: auto-prepare on present + surfaces carry the button/panel.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
assert.match(read('src/voice.js'), /prepareVoicePreview\(it\.sessionId\)/, 'the voice loop pre-captures for the presented item');
assert.match(read('src/server.js'), /'\.\/voice_preview\.js'/, 'voice_preview is a loaded feature module');
assert.match(read('web/voicemode.js'), /vm-preview-panel/, 'the overlay has the visual-check panel');
assert.match(read('web/voicemode.js'), /voice-preview\?prepare=1/, 'a tap warms the capture too');

console.log('voice_preview.test ok');
process.exit(0); // the voice_preview import chain pulls in sessions.js/server.js (poll timers) — exit explicitly
