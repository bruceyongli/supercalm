import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-phone-'));
const port = 30000 + Math.floor(Math.random() * 9000);
process.env.AIOS_PORT = String(port); // phone_api pulls in server.js — keep it off the live port

const { db, addMessage } = await import('../src/store.js');
const { recordUsage } = await import('../src/usage_store.js');
const { unreadBySession } = await import('../src/phone_api.js');
const { bus } = await import('../src/bus.js');

// seed a session + conversation shape: out (old) -> in (reply) -> out, out (new episode)
// Keep the fixture lifecycle-terminal so importing the real session monitor during the full suite cannot
// concurrently retire its intentionally nonexistent tmux pane. Read/dismiss semantics are status-agnostic.
db.prepare("INSERT INTO sessions (id, project_id, tool, tmux, status, started_at, last_activity) VALUES ('s_ph','p_ph','codex','tmx_ph','exited', 1, 1)").run();
addMessage('s_ph', 'out', 'detect', 'old report before the reply');
await new Promise((r) => setTimeout(r, 5));
addMessage('s_ph', 'in', 'text', 'operator replied here');
await new Promise((r) => setTimeout(r, 5));
addMessage('s_ph', 'out', 'detect', 'new report A after the reply');
addMessage('s_ph', 'out', 'detect', 'new report B after the reply');

// ---- unread semantics: only out-messages NEWER than the last operator reply count ------------------
{
  const u = unreadBySession().get('s_ph');
  assert.equal(u.n, 2, 'the pre-reply report is structurally read (answering clears history)');
  const plan = db.prepare(`EXPLAIN QUERY PLAN
    WITH last_in AS (
      SELECT session_id, MAX(ts) last_ts FROM messages WHERE direction='in' GROUP BY session_id
    )
    SELECT m.session_id
    FROM messages m LEFT JOIN last_in i ON i.session_id=m.session_id
    WHERE m.direction='out' AND m.read_at IS NULL AND m.ts>COALESCE(i.last_ts,0)
    GROUP BY m.session_id`).all();
  assert(plan.some((row) => /idx_messages_in_session_ts/.test(row.detail)), 'last replies use the compact partial index');
  assert(plan.some((row) => /idx_messages_unread_out_session_ts/.test(row.detail)), 'unread reports use the compact partial index');
}

// ---- read_at column exists (additive migration) and the read UPDATE clears by ids and by session ---
{
  const rows = db.prepare("SELECT id FROM messages WHERE session_id='s_ph' AND direction='out' ORDER BY ts DESC").all();
  db.prepare('UPDATE messages SET read_at = ? WHERE id = ?').run(Date.now(), rows[0].id); // ids-mode equivalent
  assert.equal(unreadBySession().get('s_ph').n, 1, 'per-id read marking reduces unread');
  db.prepare("UPDATE messages SET read_at = ? WHERE session_id = 's_ph' AND direction = 'out' AND read_at IS NULL").run(Date.now()); // session-mode equivalent
  assert.equal(unreadBySession().get('s_ph'), undefined, 'session-mode clears the backlog');
}

// Application traffic is gated until the deterministic feature loader finishes (server.js
// trafficAllowed) — every route below /healthz and /readyz answers 503 while boot is still walking
// FEATURE_MODULES. Importing phone_api.js only starts that walk; it does not await it. Under `npm
// test` the suite shares the box with three other workers, boot outruns any fixed sleep, and the
// first fetch below took a 503 instead of a 200. Await the same handle session_file_viewer.test.js
// uses, so the HTTP assertions measure the route rather than the machine's load.
const { featureReady } = await import('../src/server.js');
await featureReady;

// ---- voice evidence combines project purpose, task contract, and real recent conversation --------
{
  const { addEvent } = await import('../src/store.js');
  const { setContext } = await import('../src/context_doc.js');
  const { createTask, upsertRuntime } = await import('../src/agents/supervisor/project_memory.js');
  const { projectIdentityFor, voiceEvidenceFor } = await import('../src/voice.js');
  assert.equal(projectIdentityFor({ name: 'aios', path: process.cwd() }), 'aios/supercalm',
    'spoken orientation combines the operator’s project name with the repository product identity');
  db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES ('p_voice_context', 'Calm Shop', '/missing/calm-shop', 1)").run();
  db.prepare(`
    INSERT INTO sessions
      (id, project_id, tool, tmux, title, status, started_at, last_activity)
    VALUES ('s_voice_context', 'p_voice_context', 'codex', 'tmx_voice_context', 'Repair checkout', 'exited', 1, 1)
  `).run();
  addEvent('s_voice_context', 'launch-queued', {});
  addMessage('s_voice_context', 'in', 'task', 'Keep Apple Pay working while repairing checkout.');
  addMessage('s_voice_context', 'out', 'agent', 'Card checkout passes, but Apple Pay verification still fails.');
  setContext('p_voice_context', {
    doc: '# Calm Shop\nCalm Shop is the customer checkout application for the storefront.',
    source: 'test',
  });
  const card = createTask({
    projectId: 'p_voice_context',
    title: 'Repair checkout safely',
    goal: 'Restore checkout without regressing Apple Pay.',
    criteria: ['Card checkout passes', 'Apple Pay passes'],
    sessionId: 's_voice_context',
  });
  upsertRuntime('s_voice_context', { project_id: 'p_voice_context', active_task_id: card.task.id });
  const evidence = await voiceEvidenceFor({ sessionId: 's_voice_context', project: 'Calm Shop', tool: 'codex' });
  assert.match(evidence.projectContext, /customer checkout application/);
  assert.match(evidence.taskContext, /Restore checkout without regressing Apple Pay/);
  assert.match(evidence.taskContext, /Still required: Apple Pay passes/);
  assert.match(evidence.recentConversation, /Operator: Keep Apple Pay working/);
  assert.match(evidence.recentConversation, /Agent report: Card checkout passes/);
}

// ---- boot repair recovers only waiting hooks whose latest operator input has no later report ------
{
  const { addEvent } = await import('../src/store.js');
  const { repairMissedHookAttention } = await import('../src/hooks.js');
  const insert = db.prepare(`
    INSERT INTO sessions
      (id, project_id, tool, tmux, title, status, started_at, last_activity)
    VALUES (?, 'p_ph', 'codex', ?, ?, 'waiting', 1, 1)
  `);
  insert.run('s_hook_stranded', 'tmx_hook_stranded', 'Report the finished phone work');
  addMessage('s_hook_stranded', 'in', 'task', 'Fix the phone UI');
  addEvent('s_hook_stranded', 'hook', { tool: 'codex', event: 'agent-turn-complete' });

  insert.run('s_hook_reviewed', 'tmx_hook_reviewed', 'Do not reopen this reviewed report');
  addMessage('s_hook_reviewed', 'in', 'task', 'Already handled');
  addEvent('s_hook_reviewed', 'hook', { tool: 'codex', event: 'agent-turn-complete' });
  const reviewed = addMessage('s_hook_reviewed', 'out', 'detect', 'Already reviewed');
  db.prepare('UPDATE messages SET read_at = ? WHERE id = ?').run(Date.now(), reviewed.id);

  const recovered = repairMissedHookAttention();
  assert.deepEqual(recovered, ['s_hook_stranded']);
  assert.equal(unreadBySession().get('s_hook_stranded')?.n, 1, 'the stranded completion becomes visible in Needs You');
  assert.equal(unreadBySession().get('s_hook_reviewed'), undefined, 'a reviewed completion is not reopened');
  db.prepare("UPDATE messages SET read_at = ? WHERE session_id = 's_hook_stranded' AND direction = 'out'").run(Date.now());
  db.prepare("UPDATE sessions SET status = 'working', category = NULL, summary = NULL WHERE id = 's_hook_stranded'").run();
}

// ---- lifecycle hooks publish a durable Needs You report immediately --------------------------------
{
  db.prepare(`
    INSERT INTO sessions
      (id, project_id, tool, tmux, title, status, started_at, last_activity)
    VALUES ('s_hook_report', 'p_ph', 'codex', 'tmx_hook_report', 'Finish the mobile composer', 'working', 1, 1)
  `).run();
  const patchPromise = new Promise((resolve) => {
    const listener = (patch) => {
      if (patch.session !== 's_hook_report' || patch.source !== 'hook') return;
      bus.off('session-status', listener);
      resolve(patch);
    };
    bus.on('session-status', listener);
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/hook/codex`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 's_hook_report', event: 'agent-turn-complete' }),
  });
  assert.equal(response.status, 200);
  const patch = await Promise.race([patchPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('missing hook attention patch')), 1000))]);
  assert.equal(patch.status, 'waiting');
  assert.equal(patch.category, 'review', 'a safe visible category does not wait for asynchronous summarization');
  assert.equal(patch.unread, 1, 'the hook transition creates the unread report that powers Needs You');
  assert.equal(patch.last_key?.text, 'Finish the mobile composer');
  const home = await fetch(`http://127.0.0.1:${port}/api/phone/home`).then((r) => r.json());
  const row = home.sessions.find((session) => session.id === 's_hook_report');
  assert.equal(row?.status, 'waiting');
  assert.equal(row?.unread, 1);
  assert.equal(row?.category, 'review');
  await fetch(`http://127.0.0.1:${port}/api/hook/codex`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 's_hook_report', event: 'agent-start' }),
  });
}

// ---- voice queue is exactly Needs You, not every lifecycle-waiting session ------------------------
{
  const { buildVoiceItems } = await import('../src/voice.js');
  const { dismissAttention } = await import('../src/attention_store.js');
  const insert = db.prepare(`
    INSERT INTO sessions
      (id, tool, tmux, title, status, category, summary, question, started_at, last_activity)
    VALUES (?, 'codex', ?, ?, ?, ?, ?, ?, 1, ?)`);
  const seed = (id, { status = 'waiting', category = 'review', read = false, dismiss = false } = {}) => {
    const request = `Original request for ${id}`;
    const latest = `Latest curated report for ${id}`;
    insert.run(id, `tmx_${id}`, request, status, category, latest, latest, Date.now());
    addMessage(id, 'in', 'task', request);
    const report = addMessage(id, 'out', 'detect', latest);
    if (read) db.prepare('UPDATE messages SET read_at = ? WHERE id = ?').run(Date.now(), report.id);
    if (dismiss) dismissAttention(id, report.id);
    return { request, latest };
  };
  seed('s_voice_need_one');
  const focused = seed('s_voice_need_two', { category: 'decision' });
  seed('s_voice_read', { read: true });
  seed('s_voice_dismissed', { dismiss: true });
  seed('s_voice_stopped', { status: 'exited' });
  seed('s_voice_false_positive', { category: 'working' });

  const items = buildVoiceItems('s_voice_need_two', { onTheGo: true });
  assert.deepEqual(items.map((item) => item.sessionId), ['s_voice_need_two', 's_voice_need_one'],
    'spoken count and order contain only the two cards actually visible in Needs You');
  assert.equal(items[0].originalRequest, focused.request, 'the briefing starts from the operator’s original request');
  assert.equal(items[0].latestReport, focused.latest, 'the briefing uses the latest curated report');
}

// ---- the real read route emits one scoped unread patch (no broad reload required) -----------------
{
  addMessage('s_ph', 'out', 'detect', 'a new unread report for cross-client sync');
  const event = new Promise((resolve) => bus.once('session-status', resolve));
  await new Promise((r) => setTimeout(r, 30));
  const response = await fetch(`http://127.0.0.1:${port}/api/messages/read`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 's_ph' }),
  });
  assert.equal(response.status, 200);
  const patch = await Promise.race([event, new Promise((_, reject) => setTimeout(() => reject(new Error('missing scoped read event')), 1000))]);
  assert.deepEqual({ session: patch.session, unread: patch.unread, source: patch.source }, { session: 's_ph', unread: 0, source: 'read' });
}

// ---- inbox dismissal clears only the report boundary visible at click time ------------------------
{
  addMessage('s_ph', 'out', 'detect', 'current report part A');
  addMessage('s_ph', 'out', 'detect', 'current report part B');
  const boundary = db.prepare("SELECT MAX(id) id FROM messages WHERE session_id='s_ph' AND direction='out'").get().id;
  // Simulate a fresh work-status report racing the dismissal request. It must remain unread because its
  // id is newer than the card's last_key.id boundary.
  addMessage('s_ph', 'out', 'detect', 'future report after the visible boundary');
  const response = await fetch(`http://127.0.0.1:${port}/api/messages/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's_ph', through_id: boundary, dismiss: true }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.marked, 2, 'dismissal marks every unread report through the visible boundary');
  assert.equal(result.unread, 1, 'a newer report survives and can reopen Needs you');
  assert.equal(result.dismissal.dismissed, false, 'a report racing the click cancels the dismissal episode');
  assert.equal(unreadBySession().get('s_ph').n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM attention_dismissals WHERE session_id='s_ph'").get().n, 0);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s_ph'").get().status, 'exited', 'dismissal never mutates lifecycle status');
}

// ---- durable dismissal is visible to every home fetch and Restore removes the shared record -------
{
  const boundary = db.prepare("SELECT MAX(id) id FROM messages WHERE session_id='s_ph' AND direction='out'").get().id;
  const event = new Promise((resolve) => bus.once('session-status', resolve));
  const response = await fetch(`http://127.0.0.1:${port}/api/messages/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's_ph', through_id: boundary, dismiss: true }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.dismissal.dismissed, true);
  const patch = await Promise.race([event, new Promise((_, reject) => setTimeout(() => reject(new Error('missing scoped dismissal event')), 1000))]);
  assert.deepEqual(
    { session: patch.session, unread: patch.unread, dismissed: patch.dismissed, source: patch.source },
    { session: 's_ph', unread: 0, dismissed: true, source: 'dismiss' },
  );
  for (let i = 0; i < 2; i++) {
    const home = await fetch(`http://127.0.0.1:${port}/api/phone/home`).then((r) => r.json());
    const row = home.sessions.find((session) => session.id === 's_ph');
    assert.equal(row.dismissed, true, `home fetch ${i + 1} sees the same server-side dismissal`);
    assert.equal(row.dismissed_report_id, boundary);
  }
  const restore = await fetch(`http://127.0.0.1:${port}/api/attention/s_ph/restore`, { method: 'POST' });
  assert.equal(restore.status, 200);
  assert.equal((await restore.json()).reopened, false, 'an exited session is removed from history without becoming a false need');
  const home = await fetch(`http://127.0.0.1:${port}/api/phone/home`).then((r) => r.json());
  assert.equal(home.sessions.find((session) => session.id === 's_ph').dismissed, false);
}

// ---- route + payload locks --------------------------------------------------------------------------
{
  const src = readFileSync(new URL('../src/phone_api.js', import.meta.url), 'utf8');
  const migrations = readFileSync(new URL('../src/schema_migrations.js', import.meta.url), 'utf8');
  assert.match(migrations, /ensureColumn\(db, 'messages', 'read_at'/, 'read state belongs to the central migration ledger');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE id='0002_message_read_state'").get().n, 1, 'read-state migration is recorded');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE id='0003_attention_dismissals'").get().n, 1, 'attention-dismissal migration is recorded');
  assert.match(src, /\/api\/messages\/read/, 'read route exists');
  assert.match(src, /through_id/, 'read route supports report-bounded inbox dismissal');
  assert.match(src, /\/api\/attention\/:id\/restore/, 'dismissed attention can be explicitly restored');
  assert.match(src, /\/api\/phone\/home/, 'lean home route exists');
  assert.match(src, /bus\.emit\('session-status'/, 'read state publishes a scoped keyed patch');
  assert.match(src, /read_at IS NULL/, 'unread respects server-side read state');
  assert.match(src, /WITH last_in AS/, 'unread derives the last operator reply once per session');
  assert.match(src, /MAX\(id\) last_id/, 'message ids preserve reply/report order even inside one millisecond');
  assert.doesNotMatch(src, /m\.ts > COALESCE\(\(SELECT MAX\(ts\)/, 'unread never repeats a correlated MAX query for every message');
  assert.match(migrations, /idx_messages_in_session_ts/, 'last replies use a compact partial index');
  assert.match(migrations, /idx_messages_unread_out_session_ts/, 'unread reports use a compact partial index');
  assert.match(src, /s\.project_id/, 'home rows retain their project identity for keyed project counts');
  const ph = readFileSync(new URL('../web/phone.js', import.meta.url), 'utf8');
  assert.match(ph, /fake-?field/i, 'composer is a fake pill (focus rule)');
  assert.ok(!/autofocus/i.test(ph.replace(/autoFocus="\{\{ true \}\}"/g, '')), 'nothing autofocuses');
  assert.match(ph, /stopped mid-queue: do NOT mark read/, 'read-on-completion semantics');
  assert.match(ph, /shared concierge/i,
    'phone Voice updates uses the same Voice Assistant conversation');
  assert.match(ph, /from '\.\/voicemode\.js'/,
    'phone imports the same gesture-unlocked Voice client as desktop and the installed PWA');
  const adapter = ph.slice(ph.indexOf('setOnTheGoVoiceAdapter({'), ph.indexOf('subscribeOnTheGo('));
  assert.match(adapter, /active: isVoiceModeActive/);
  assert.match(adapter, /startVoiceMode\(options\)/);
  assert.doesNotMatch(adapter, /voiceModeStart\(/,
    'phone never routes Voice updates back through its older suspended-AudioContext loop');
  assert.match(ph, /startVoiceMode\(\{ source: 'manual' \}\)/,
    'the manual phone button also uses the shared Voice client');
  assert.match(ph, /result\.json\.reason === 'pending-draft'[\s\S]*post\(true\)/,
    'the standalone phone composer also reconciles an unfinished Terminal draft');
  assert.match(ph, /Kept the unfinished Terminal draft here/,
    'phone keeps the displaced native draft visible after the new message sends');
  assert.doesNotMatch(ph, /Session is still resuming/,
    'phone never invents a resuming lifecycle state for a blocked input');
  const sharedVoice = readFileSync(new URL('../web/voicemode.js', import.meta.url), 'utf8');
  assert.match(sharedVoice, /api\/transcribe\?language=auto&polish=true/,
    'the shared Voice client keeps conversational transcript cleanup before reasoning');
  assert.match(sharedVoice, /speakSmart\(text, handle,[\s\S]*continuous: true/,
    'Voice Assistant replies are synthesized as one continuous utterance');
  const sv = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(sv, /\/phone'\) p = '\/phone\.html'/, 'extensionless /phone serves the app');
  // The canonical shell defaults to phone HOME at phone widths, while sessions use the one shared
  // responsive Story/Terminal implementation and retain a return marker for the phone inbox.
  const shell = readFileSync(new URL('../web/app.html', import.meta.url), 'utf8');
  const router = readFileSync(new URL('../web/router.js', import.meta.url), 'utf8');
  const sessionView = readFileSync(new URL('../web/session.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('../web/phone.webmanifest', import.meta.url), 'utf8'));
  assert.match(shell, /innerWidth[\s\S]*location\.replace[\s\S]*\/phone/, 'the canonical shell redirects phone-sized launches');
  assert.match(ph, /\[data-open\][\s\S]*openCanonicalSession/, 'phone session cards open the canonical session view');
  assert.match(ph, /session\?id=.*from=phone/, 'phone session links preserve their return destination');
  assert.match(router, /Phone-inbox session links use `from=phone`/, 'the SPA does not route phone sessions to a second renderer');
  assert.match(sessionView, /params\.get\('from'\) === 'phone'[\s\S]*backLink\.href = 'phone#home'/,
    'the shared session Back control returns to phone home');
  assert.equal(manifest.start_url, './phone#home', 'an installed phone PWA launches directly into phone home');
  assert.match(sv, /session\|records\|decisions\|usage\|health\|settings\|projects\).*\\?\\.html/, 'historical desktop .html routes serve the canonical SPA');
}

// The lean Usage projection is computed in a worker and remains callable in an isolated install.
{
  const response = await fetch(`http://127.0.0.1:${port}/api/usage/summary?range=30d`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(Number(body.totals?.sessions || 0), 0);
}

// Explicit windows inside the same five-minute interval are distinct cache entries.
{
  const bucket = Math.floor(Date.now() / 300000) * 300000;
  recordUsage({ source_id: 'explicit-a', source: 'test', ts: bucket + 10_500, total_tokens: 11 });
  recordUsage({ source_id: 'explicit-b', source: 'test', ts: bucket + 12_500, total_tokens: 29 });
  const getWindow = async (since, until) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/usage/summary?range=all&since=${since}&until=${until}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await getWindow(bucket + 10_000, bucket + 11_000);
  const second = await getWindow(bucket + 12_000, bucket + 13_000);
  assert.equal(first.totals.total_tokens, 11);
  assert.equal(second.totals.total_tokens, 29, 'an explicit window never reuses a neighboring cached report');
  assert(second.recent.every((row) => row.ts >= bucket + 12_000 && row.ts <= bucket + 13_000));
}

console.log('phone_api.test ok');
process.exit(0); // the phone_api import chain pulls in server.js (listeners + poll timers) — exit explicitly
