// Guards for two operator-reported first-paint regressions (both shipped in the same fix):
//   1. The Supervisor panel flashed the retired "Supervision Doc" for one frame before the task card
//      ("what's the purpose of flashing it?"). Cause: renderDoc() runs synchronously while the async
//      loadTasks() is still in flight, so pmData is null and it falls through to the legacy-doc branch,
//      then re-renders as the card when the fetch resolves.
//   2. The sidebar dropped stopped sessions entirely (live-only filter + slice(0,7)) — "the session page
//      no longer showing stopped sessions, please add it back."
// These are static source invariants (like sidebar_consistency.test.js): they fail the moment a refactor
// reintroduces either class, without needing a headless browser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../web/' + p, import.meta.url), 'utf8');

// ---- Issue 1: no doc→card flash — renderDoc bails to a neutral state until the card fetch resolves ---
{
  const sup = read('agents/supervisor.js');
  const rd = sup.indexOf('function renderDoc()');
  assert.ok(rd > 0, 'renderDoc exists');
  const body = sup.slice(rd, rd + 1800);
  const gate = body.indexOf('pmLoaded');
  const cardBranch = body.indexOf('if (pmData)');
  assert.ok(gate > 0, 'renderDoc guards on the loaded flag (pmLoaded) so it does not guess before the fetch');
  assert.ok(cardBranch > 0, 'renderDoc still has the pmData card branch');
  assert.ok(gate < cardBranch, 'the not-loaded guard runs BEFORE the doc/card branch — the first paint is never the retired doc');
  assert.ok(/if \(!pmLoaded[\s\S]{0,700}?return/.test(body), 'the not-loaded guard returns early (paints neither doc nor card yet)');

  // loadTasks must flip the flag on BOTH success and failure, or the panel hangs on the skeleton forever.
  const lt = sup.indexOf('async function loadTasks');
  assert.ok(lt > 0, 'loadTasks exists');
  const ltBody = sup.slice(lt, lt + 500);
  assert.ok(/pmLoaded = true/.test(ltBody), 'loadTasks sets pmLoaded = true after the try/catch (success or failure)');
  const flip = ltBody.indexOf('pmLoaded = true');
  const rerender = ltBody.indexOf('renderDoc()');
  assert.ok(flip > 0 && rerender > flip, 'pmLoaded flips before the re-render, so the resolved render shows doc-or-card, never the skeleton');
}

// ---- Issue 2: the sidebar shows stopped sessions, not just live -------------------------------------
// Stopped sessions belong in the PAGE BODY (desktop.js #dk-rows), NOT the side nav rail (operator
// correction: "put stopped in the side menu instead of in the session page" — wrong surface). The rail
// stays a lean live-only quick-nav.
{
  const shell = read('shell.js');
  const rs = shell.indexOf('function renderSide()');
  assert.ok(rs > 0, 'renderSide exists');
  const rail = shell.slice(rs, rs + 1400);
  assert.ok(!/STOPPED/.test(rail), 'the side rail must NOT render a STOPPED section — stopped go in the page body');

  const desk = read('desktop.js');
  const ri = desk.indexOf('function renderInbox');
  assert.ok(ri > 0, 'renderInbox exists');
  const inbox = desk.slice(ri, ri + 7000);
  assert.ok(/!== 'working'/.test(inbox) && /!== 'waiting'/.test(inbox), 'renderInbox keeps a stopped bucket for the page body');
  assert.ok(/STOPPED/.test(inbox), 'renderInbox renders a STOPPED section in the page body (#dk-rows)');
  assert.ok(/dk-rows/.test(inbox), 'the STOPPED section targets the page-body #dk-rows list');
}

// ONE unified sidebar width: both shells derive from a single --rail-width token so the dashboard and
// session rails can't drift to two widths again (operator: "why maintain two sidebars … different width").
// Collapse must change that ONE token — separate grid/#view overrides desynchronized into the screenshot's
// hidden sidebar + 280px blank strip (2026-07-20).
{
  const dcss = read('desktop.css');
  assert.ok(/:root\s*\{[^}]*--rail-width:\s*280px/.test(dcss), 'desktop.css defines the expanded shared --rail-width token');
  assert.ok(/body\.dk-collapsed\s*\{[^}]*--rail-width:\s*0px/.test(dcss), 'collapsed state zeroes the shared token once');
  assert.ok(/\.dk-shell\s*\{[^}]*grid-template-columns:\s*var\(--rail-width\)/.test(dcss), '.dk-shell rail width uses var(--rail-width)');
  assert.ok(/\.dk-shell > \.dk-view, \.dk-shell > \.dk-main\s*\{[^}]*grid-column:\s*2/.test(dcss), 'normal shell content is pinned to column 2 — hiding column-1 sidebar cannot auto-place it into the 0px track');
  assert.ok(/body:not\(\.session-page\) \.dk-shell > \.dk-view,[\s\S]{0,100}grid-column:\s*1/.test(dcss), 'mobile single-column shell resets content to column 1');
  assert.ok(/\.dk-expand\s*\{[^}]*top:\s*16px/.test(dcss) && !/\.dk-expand\s*\{[^}]*top:\s*50%/.test(dcss), 'restore tab sits at the top near the former collapse control, not mid-screen');
  assert.ok(/body\.session-page #view\.dk-view\s*\{[^}]*left:\s*var\(--rail-width\)/.test(dcss), 'fixed session #view offset uses the SAME token');
  assert.ok(!/body\.dk-collapsed \.dk-shell\s*\{[^}]*grid-template-columns/.test(dcss), 'no separate collapsed grid geometry can drift');
  assert.ok(!/body\.dk-collapsed\.session-page #view\.dk-view\s*\{[^}]*left/.test(dcss), 'no separate collapsed #view offset can drift');
  const scss = read('styles.css');
  assert.ok(/--session-rail-width:\s*var\(--rail-width/.test(scss), 'the session shell derives its rail width from the shared --rail-width token');
  assert.ok(/\.session-shell\.embedded\s*\{[^}]*--session-rail-width:\s*0px/.test(scss), 'embedded SPA session still suppresses the second/internal rail');

  const shell = read('shell.js');
  assert.ok(/const setCollapsed = \(v\)/.test(shell) && /aios\.rail\.collapsed/.test(shell), 'one persisted setCollapsed transition owns the state');
  assert.ok(/e\.code === 'Backslash'/.test(shell) && /setCollapsed\(!document\.body\.classList\.contains\('dk-collapsed'\)\)/.test(shell), 'Cmd/Ctrl+Backslash reuses setCollapsed');
}

// Story-view session-switch race: refreshStory() reads the module-level `sid` before AND after an
// await; a fast session switch mid-fetch would apply session A's story to session B's feed + cache
// (operator report 2026-07-13: a share/bb2 story rendered under the aios session's header). The fix
// captures sid and bails if it changed after the await. This tripwire fails if that guard is removed.
{
  const sv = read('story-view.js');
  const rs = sv.indexOf('export async function refreshStory');
  assert.ok(rs > 0, 'refreshStory exists');
  const body = sv.slice(rs, rs + 3600);
  assert.ok(/const mySid\s*=\s*sid/.test(body), 'refreshStory captures the session id (mySid) before the await');
  assert.ok(/api\(`api\/session\/\$\{mySid\}\/story/.test(body), 'refreshStory fetches with the captured mySid, not the live sid');
  assert.ok(/if\s*\(\s*sid\s*!==\s*mySid\s*\)\s*return/.test(body), 'refreshStory discards a response once a switch has re-pointed sid (no cross-session leak)');
  assert.ok(/writeStoryCache\(mySid/.test(body), 'refreshStory writes the cache under the captured session id');
}

// Fresh-install add-project (first-time-user report, 2026-07-16): with ZERO projects, "+ new project…"
// is the launch modal's pre-selected first option, so an onchange-only visibility wire never fires and
// the path field stays hidden — the redesign's ONLY add-project surface was a dead end. The modal must
// SYNC visibility at open, and the Projects page must open this modal in place (its old header link and
// row buttons navigated to the legacy desktop page with a #launch= hash nothing handles).
{
  const shell = read('shell.js');
  const ol = shell.indexOf('export async function openLaunch');
  assert.ok(ol > 0, 'openLaunch exists');
  const body = shell.slice(ol, ol + 6000);
  assert.ok(/const syncNewProj = /.test(body), 'openLaunch defines the newproj visibility sync');
  assert.ok(/onchange = syncNewProj/.test(body), 'the sync is the onchange handler');
  assert.ok(/\n\s*syncNewProj\(\);/.test(body), 'the sync ALSO runs at open — zero-projects installs start on "+ new project…" with no change event');

  for (const f of ['views/projects.js']) {
    const pj = read(f);
    assert.ok(!/desktop#launch/.test(pj), `${f}: no navigation to the legacy desktop #launch hash (nothing handles it)`);
    assert.ok(/openLaunch\(\{ ?projectId/.test(pj), `${f}: row "+ session" opens the launch modal with the project preselected`);
    assert.ok(/openLaunch\(\{ ?newProject: true ?\}\)/.test(pj), `${f}: the add-project affordance opens the launch modal on the new-project fields`);
  }

  // The server honors what the modal sends for a new project: custom name + the KB checkbox.
  const sess = readFileSync(new URL('../src/sessions.js', import.meta.url), 'utf8');
  assert.ok(/String\(b\.name \|\| ''\)\.trim\(\) \|\| basename\(p\)/.test(sess), 'POST /api/session uses the optional Name for the auto-created project');
  assert.ok(/boolParam\(b\.kb\)/.test(sess) && /rebuildWiki\(project\)/.test(sess), 'POST /api/session honors the Build-knowledge-base checkbox (fire-and-forget wiki rebuild)');
}

// Upgrade/setup orientation (first-time-user report, 2026-07-16): the empty-inbox hero must not claim
// "setup complete" on an unconfigured install; the version badge orients upgraders ("updated while you
// were away → review Settings"); the footer auth chip must not hardcode a green "proxy" dot.
{
  const { setupVerdict } = await import('../web/common.js');
  assert.deepEqual(setupVerdict({ tools: [{ installed: true }], auth: { mode: 'proxy', providers: [] } }), { ok: true, missing: null }, 'CLI + proxy = ready');
  assert.deepEqual(setupVerdict({ tools: [{ installed: true }], auth: { providers: [{ loggedIn: true }] } }), { ok: true, missing: null }, 'CLI + a login = ready');
  assert.equal(setupVerdict({ tools: [], auth: { mode: 'proxy' } }).missing, 'agents', 'no CLI → missing agents (checked first)');
  assert.equal(setupVerdict({ tools: [{ installed: true }], auth: { mode: 'cli', providers: [] } }).missing, 'signin', 'no credential → missing signin');
  assert.ok(setupVerdict({ tools: [{ installed: true }], auth: { mode: 'cli' }, providers: [{ id: 'x' }] }).ok, 'a user API provider counts as credentialed');

  const dash = read('views/dashboard.js');
  assert.ok(/data-dk-setupline/.test(dash) && /setupVerdict/.test(dash), 'the dashboard hero setup line derives from setupVerdict');
  assert.ok(/href="onboarding"/.test(dash), 'an unfinished setup points at the onboarding wizard');
  assert.ok(!/✓ setup complete[^<]*<\/span><p>/.test(dash.replace(/paintSetupLine[\s\S]*?\n}/, '')), 'the hero markup itself no longer hardcodes "setup complete"');

  const vb = read('version-badge.js');
  assert.ok(/aios_seen_version/.test(vb) && /checkUpgraded\(version, v\?\.channel\)/.test(vb), 'version badge remembers the last-seen version and checks the release channel before post-upgrade orientation');
  assert.ok(/aios_upgrade_notified_version/.test(vb) && /UPGRADE_NOTICE_MS/.test(vb), 'post-upgrade orientation is recorded once per version and auto-dismisses');
  assert.ok(/function dismissToast/.test(vb) && /el\.onclick = null/.test(vb) && /el\.remove\(\)/.test(vb), 'dismissal destroys the toast and its Settings click handler');
  const css = read('styles.css');
  assert.match(css, /\.version-toast\s*\{[\s\S]*?pointer-events:\s*none/, 'hidden version toast never participates in hit-testing');
  assert.match(css, /\.version-toast\.in\s*\{[^}]*pointer-events:\s*auto/, 'only the visible version toast accepts pointer input');

  // Shape contract: onboarding/settings consume {installed, version}; the endpoint natively computes
  // {current}. The server must serve BOTH — the mismatch rendered every CLI "not installed" and wedged
  // the onboarding step-1 gate on machines where the CLIs are fine.
  const tu = readFileSync(new URL('../src/tool_updates.js', import.meta.url), 'utf8');
  assert.ok(/installed: !!current/.test(tu) && /version: current/.test(tu), 'tools/versions serves installed+version aliases alongside current');
  assert.ok(setupVerdict({ tools: [{ current: '1.0.0' }], auth: { mode: 'proxy' } }).ok, 'setupVerdict tolerates the bare {current} shape too');

  const shell = read('shell.js');
  assert.ok(!/dk-dot ok"><\/i>proxy</.test(shell), 'the footer auth chip is not a hardcoded green "proxy" dot');
  assert.ok(/api\('api\/auth\/status'\)/.test(shell), 'the footer auth chip reflects the real auth mode');
}

// Sidebar rail economy (operator, 2026-07-16): the dot IS the status — no Working/Waiting words in the
// rail rows (the page-body list keeps them; renderInbox is asserted above). Footer shows the BUILD
// (version) + auth mode, not hostname/clock.
{
  const shell = read('shell.js');
  const rs = shell.slice(shell.indexOf('function renderSide()'), shell.indexOf('function renderSide()') + 2600);
  assert.ok(!/dk-status/.test(rs), 'rail rows carry no dk-status word — the dot is the status');
  assert.ok(/dk-sess-age/.test(rs) && /fmtAgo\(s\.last_activity\)/.test(rs), 'rail rows show the last-activity age instead');
  assert.ok(/appVersion/.test(rs), 'the footer leads with the running version');
  assert.ok(!/dk-clock/.test(shell), 'the footer wall clock is gone (the OS shows the time)');
  const dcss = read('desktop.css');
  assert.ok(/\.dk-sess-l1 b[^}]*flex: 1 1 auto/.test(dcss), 'the rail title flexes into the freed width');
  assert.ok(/\.dk-sess-age/.test(dcss), 'the rail age style exists');
}


// The Projects "index" button must call the real rebuild endpoint. It used to GET
// /graph?rebuild=1 — a param the GET route ignores — so it 200'd, claimed "indexed ✓", and
// nothing was ever indexed (E2E finding #2).
{
  for (const f of ['views/projects.js']) {
    const pj = read(f);
    assert.ok(!/graph\?rebuild=1/.test(pj), `${f}: no GET ?rebuild=1 (the route ignores it)`);
    assert.ok(/graph\/rebuild`, \{ method: 'POST' \}/.test(pj), `${f}: index button POSTs the rebuild route`);
  }
}

console.log('ui_render_invariants: no-flash guard + stopped-in-page-body + one unified rail width + story-switch race guard + fresh-install add-project + honest setup/upgrade orientation');
