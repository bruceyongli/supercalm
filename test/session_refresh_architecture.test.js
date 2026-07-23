import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

// Programmatic action paths stay inside the single document.
{
  const shell = read('web/shell.js');
  const launch = shell.slice(shell.indexOf('export async function openLaunch'), shell.indexOf('// ---- toast'));
  assert.match(launch, /navigate\(`session\?id=/, 'launch uses the SPA navigation seam');
  assert.doesNotMatch(launch, /location\.href/, 'launch never hard-navigates');
  assert.match(shell, /api\('api\/launch-options'\)/, 'launcher uses the lean options projection');
  assert.doesNotMatch(launch, /api\('api\/state'\)/, 'opening the launcher does not load full state');

  const session = read('web/session.js');
  const kill = session.slice(session.indexOf("$('#b-kill').onclick"), session.indexOf('// ---- teardown'));
  assert.match(kill, /navigate\('\.\/'\)/, 'kill routes home in place');
  assert.doesNotMatch(kill, /location\.href|location\.reload/, 'kill never replaces the document');
  assert.match(kill, /upsertSession\(\{ id, status: 'exited'/, 'kill patches the keyed row optimistically');
}

// One structured stream patches a normalized store; generic changed no longer fans out broad loads.
{
  const shell = read('web/shell.js');
  assert.match(shell, /const sessionsById = new Map\(\)/, 'shell owns a normalized keyed session store');
  assert.match(shell, /addEventListener\('session-status'/, 'shell consumes structured session events');
  assert.match(shell, /previousStatus: row\.status/, 'store replay is metadata, not a false semantic transition');
  assert.doesNotMatch(shell, /addEventListener\('changed'/, 'shell ignores global invalidation events');
  assert.match(shell, /reconcileKeyed\(\$\('#dk-sessions'\)/, 'rail reconciles keyed rows');
  const session = read('web/session.js');
  assert.match(session, /subscribeSessionEvents/, 'embedded session reuses the shell stream');
  assert.match(session, /subscribeSessionEvents\(onSessionStatus, \{ replayId: id \}\)/, 'session subscription replays a status event missed during mount');
  assert.doesNotMatch(session, /addEventListener\('changed'/, 'detail view has no generic refresh fan-out');
  assert.doesNotMatch(session, /setInterval\(loadUsage|loadUsage\(\);\s*\n\s*_timers/, 'hidden usage has no eager polling interval');
  const settings = session.slice(session.indexOf('async function loadSettings'), session.indexOf('// ---- reply composer'));
  assert.doesNotMatch(settings, /api\('api\/state'\)/, 'session settings never fetch broad state');
  assert.match(settings, /fetchSessionInfo\(reqId\)/, 'session header and settings share one detail request');
  assert.match(settings, /fetchToolsMeta\(\)/, 'session settings use the lean tool catalog');
  assert.match(session, /getLaunchOptions\(\)/, 'session settings share the shell launch-options request');
  assert.doesNotMatch(session, /api\('api\/launch-options'\)/, 'session mount has no independent launch-options fetch');
  assert.match(session, /if \(storyLoadPromise\) return storyLoadPromise/, 'Story initialization is in-flight coalesced');
  assert.match(session, /latestSessionInfo\.status === 'starting'/, 'terminal SSE is deferred while launch is Starting');
  assert.match(session, /termTextarea\.name = 'terminal-input'/, 'xterm helper has a stable form-field name');
  assert.match(session, /<select name="session-\$\{escapeHtml\(key\)\}"/, 'dynamic session setting selects have stable names');
  const phoneUi = read('web/phone.js');
  assert.doesNotMatch(phoneUi, /loadUsage\(\)/, 'phone navigation does not eagerly load hidden Usage');
  const dash = read('web/views/dashboard.js');
  assert.match(dash, /function reconcile\(/, 'dashboard has keyed reconciliation');
  assert.match(dash, /data-dk-row data-sid=/, 'session rows have stable session keys');
}

// Observability excludes persistent SSE lifetimes from ordinary request latency.
{
  const server = read('src/server.js');
  assert.match(server, /url\.pathname === '\/api\/events'.*api\\\/session/s, 'shared and terminal streams are classified as persistent transport');
  assert.match(server, /streamingResponse.*text\/event-stream/s, 'bounded SSE responses do not inflate latency metrics');
}

// Home is database-only; launch persists a starting row and returns before setup.
{
  const phone = read('src/phone_api.js');
  assert.doesNotMatch(phone, /storyFor|story_api|deriveQuestion/, 'home never parses transcripts');
  const sessions = read('src/sessions.js');
  assert.match(sessions, /function reserveLaunch[\s\S]*?status: 'starting'/, 'launch reserves the row in starting state');
  assert.match(sessions, /queueLaunch\([\s\S]*?setImmediate/, 'expensive launch completion runs after the response path');
  assert.match(sessions, /json\(res, 202, decorate\(s\)\)/, 'POST /api/session returns an accepted starting row');
  assert.match(sessions, /timings\.total/, 'launch phases are timed');
  assert.match(sessions, /const paneName =[\s\S]*?tmux: paneName/, 'the real pane identity is durable before async setup');
  assert.match(sessions, /if \(paneMayExist\) await tmuxOk\('kill-session'/, 'post-create tmux failures are cleaned up');
  assert.match(sessions, /cleanupArtifacts && spec\.worktree && !spec\.worktree\.reused/, 'all failed fresh launches clean their worktree');
  assert.match(sessions, /if \(s\.status === 'starting'\)[\s\S]*?alive\.has\(s\.tmux\)[\s\S]*?kill-session/, 'restart recovery retires a partially-created pane');
  assert.match(sessions, /if \(pendingLaunches\.has\(s\.id\)\) continue/, 'boot discovery never retires a launch owned by the current process');
}

// Usage and supervisor hot paths are bounded and avoid loading giant blobs repeatedly.
{
  const usage = read('src/usage_store.js');
  assert.match(usage, /idx_usage_events_session_ts/, 'session usage has a matching composite index');
  const sessionUsage = usage.slice(usage.indexOf('export function usageForSession'), usage.indexOf('function usageSessions'));
  assert.doesNotMatch(sessionUsage, /SELECT \*/, 'session usage never selects raw payload blobs');
  assert.match(sessionUsage, /SESSION_USAGE_CACHE_MS/, 'session aggregates are TTL cached');
  const ledger = read('src/agents/supervisor/decision_records.js');
  assert.match(ledger, /CREATE TABLE IF NOT EXISTS supervisor_snapshots/, 'snapshots are content-addressed');
  assert.match(ledger, /snapshots are content-addressed/, 'decision rows no longer duplicate snapshot JSON');
  assert.doesNotMatch(ledger, /SELECT \* FROM supervisor_decisions/, 'hot decision history reads explicit small columns');
  assert.match(ledger, /SUPERVISOR_SNAPSHOT_RETAIN/, 'snapshot retention is bounded');
}

// Await-aware coalescing is single-flight: a slow request cannot overlap another trailing run.
{
  const { coalesce } = await import('../web/common.js');
  const gates = [];
  let calls = 0;
  const wrapped = coalesce(() => new Promise((resolve) => { calls++; gates.push(resolve); }), 5);
  wrapped(); wrapped(); wrapped();
  await new Promise((r) => setTimeout(r, 12));
  assert.equal(calls, 1, 'events during an in-flight refresh do not overlap it');
  gates.shift()();
  await new Promise((r) => setTimeout(r, 12));
  assert.equal(calls, 2, 'one trailing refresh catches the burst after completion');
  gates.shift()();

  let fastCalls = 0;
  const fast = coalesce(() => { fastCalls++; }, 50);
  fast();
  await new Promise((r) => setTimeout(r, 8));
  fast();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fastCalls, 1, 'a completed fast refresh still observes the minimum interval');
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(fastCalls, 2, 'the fast trailing refresh runs once after the interval');
}

console.log('session_refresh_architecture.test ok');
