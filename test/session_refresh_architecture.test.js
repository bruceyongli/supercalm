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
  const recalc = shell.slice(shell.indexOf('function recalcHome'), shell.indexOf('function publishHome'));
  assert.doesNotMatch(recalc, /\.sort\(/, 'activity patches do not continually reorder the visible session lists');
  assert.match(shell, /let sessionOrder = \[\]/, 'shell keeps an explicit stable row order');
  assert.match(shell, /sessionOrder = \[next\.id, \.\.\.sessionOrder/, 'a genuinely new session is inserted at the top');
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
  const infoDeclaration = session.indexOf('let latestSessionInfo = null');
  const initialViewMount = session.indexOf('setMainView(activeMainView);');
  assert.ok(infoDeclaration >= 0 && infoDeclaration < initialViewMount,
    'session info state is initialized before a persisted Terminal view can synchronously read it');
  assert.match(session, /if \(sessionDestroyed \|\| _sig\.aborted\) return;[\s\S]*?term\.write/,
    'late terminal producers are rejected after session teardown');
  assert.match(session, /setTimeout\(\(\) => \{ try \{ terminalToDispose\?\.dispose\(\); \} catch \{\} \}, 100\)/,
    'xterm disposal waits for its already-queued viewport refresh');
  assert.match(session, /termTextarea\.name = 'terminal-input'/, 'xterm helper has a stable form-field name');
  assert.match(session, /<select name="session-\$\{escapeHtml\(key\)\}"/, 'dynamic session setting selects have stable names');
  const phoneUi = read('web/phone.js');
  assert.doesNotMatch(phoneUi, /loadUsage\(\)/, 'phone navigation does not eagerly load hidden Usage');
  const dash = read('web/views/dashboard.js');
  assert.match(dash, /function reconcile\(/, 'dashboard has keyed reconciliation');
  assert.match(dash, /data-dk-row data-sid=/, 'session rows have stable session keys');
  const records = read('web/views/records.js');
  assert.match(records, /let viewGeneration = 0/, 'Records view versions its asynchronous mounts');
  assert.match(records, /if \(!host \|\| token !== viewGeneration\) return/,
    'Records fetch continuations stop after teardown or remount');
  assert.match(records, /viewAbortController\?\.abort\(\)/,
    'Records teardown aborts requests instead of leaving discarded route work in flight');
  assert.match(records, /viewGeneration\+\+;\s*\n\s*host = null;/,
    'Records teardown invalidates every in-flight continuation before dropping its host');
}

// Attention UI: status marks stay circular and working sessions blink slowly; dismissing a Needs-you
// report is a read-state transition bounded to that report, not a session stop/kill action.
{
  const shell = read('web/shell.js');
  const css = read('web/desktop.css');
  const dash = read('web/views/dashboard.js');
  assert.match(shell, /s\.status === 'working' \? 'ok pulse'/, 'working rail dots use the slow pulse');
  assert.match(shell, /patchRailSession\(el, fresh\)/, 'sidebar activity patches retain the existing session row');
  assert.match(shell, /syncAttributes\(currentDot, nextDot\)/, 'sidebar status changes patch the connected dot instead of recreating it');
  assert.match(css, /\.dk-dot\s*\{[^}]*flex:\s*0 0 7px[^}]*border-radius:\s*50%/, 'status dots cannot flex-shrink into pipes');
  assert.match(css, /\.dk-dot\.pulse\s*\{[^}]*2\.8s/, 'working status uses a slow blink instead of rapid flashing');
  assert.match(dash, /data-dk-dismiss/, 'Needs-you cards have a visible dismiss action');
  assert.match(dash, /through_id:\s*reportId/, 'dismissal is bounded to the currently visible report');
  assert.match(dash, /upsertSession\(\{ id: sid, unread:/, 'dismissal removes the report without mutating lifecycle status');
  assert.doesNotMatch(dash.slice(dash.indexOf('async function dismiss'), dash.indexOf('function wireCards')), /stop|kill/i,
    'dismissal does not stop or kill the session');
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
  assert.match(phone, /WITH last_in AS/, 'home unread state is computed with a set-based aggregate');
  assert.doesNotMatch(phone, /m\.ts > COALESCE\(\(SELECT MAX\(ts\)/, 'home has no per-message correlated reply lookup');
  assert.match(phone, /idx_messages_unread_out_session_ts/, 'home unread scanning stays on a compact partial index');
  const projects = read('web/views/projects.js');
  assert.match(projects, /getHome\(\)/, 'Projects reuses the normalized shell snapshot');
  assert.doesNotMatch(projects, /api\('api\/phone\/home'\)/, 'Projects does not refetch the session collection');
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
  assert.match(usage, /idx_usage_events_dashboard/, 'interactive aggregates have a covering index that excludes raw payloads');
  assert.match(usage, /export function usageDashboardReport/, 'Usage has a lean screen projection');
  const usageApi = read('src/usage.js');
  assert.match(usageApi, /\/api\/usage\/summary/, 'the screen has a dedicated summary endpoint');
  assert.match(usageApi, /new Worker\(new URL\('\.\/usage_summary_worker\.js'/, 'cold analytics run outside the request event loop');
  assert.match(usageApi, /Stale-while-revalidate/, 'expired analytics render from cache while refreshing off-thread');
  assert.match(usageApi, /warmSummaryTimer/, 'the default Usage range is prewarmed after boot');
  const usageView = read('web/views/usage.js');
  assert.match(usageView, /api\/usage\/summary/, 'the screen avoids the legacy exhaustive report');
  assert.ok(usageView.indexOf("api('api/usage/subscriptions')") < usageView.indexOf('await api(`api/usage/summary'),
    'quota and usage requests start concurrently');
  const collector = read('src/usage_collect.js');
  assert.match(collector, /const codexRequest[\s\S]*const claudeRequest[\s\S]*const overviewRequest[\s\S]*await codexRequest/,
    'independent quota probes start before the first await');
  assert.match(collector, /SUBSCRIPTION_CACHE_MS/, 'slow fleet quota probes have a bounded cache');
  const health = read('src/product_health.js');
  assert.match(health, /GRAPH_SNAPSHOT_CACHE_MS/, 'project graph status is reused across nearby views');
  const graph = read('src/project_graph_core.js');
  assert.match(graph, /mapLimit\(candidates, 8/, 'multi-repo project discovery is bounded and parallel');
  assert.match(graph, /status', '--porcelain=v2', '--branch'/, 'graph freshness gets identity and changes in one git process');
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
