import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const session = read('web/session.js');
const sessionStyles = read('web/styles.css');
const reviewBackend = read('src/agents/review.js');
const reviewPanel = read('web/agents/review.js');
const settings = read('web/views/settings.js');

assert.match(session, /data-workspace-add="files"/, 'Files is available from the quiet + workspace menu');
assert.match(session, /data-workspace-add="preview"/, 'Preview is available from the quiet + workspace menu');
assert.match(session, /api\/session\/\$\{requestToken\.id\}\/files/, 'workspace files use the session-scoped file API');
assert.match(session, /frame\.setAttribute\('sandbox', ''\)/, 'HTML preview runs in an empty sandbox');
assert.match(session, /default-src 'none'/, 'HTML preview blocks scripts and network resources');
assert.match(session, /target="_blank" rel="noopener">Open tab ↗/, 'workspace files can open safely in a new tab');

assert.match(reviewBackend, /capabilities: \['read-context', 'model-calls'\]/, 'Council Review has read/model capabilities only');
assert.doesNotMatch(reviewBackend, /ctx\.sendToAgent|capabilities:\s*\[[^\]]*'send-input'/, 'Council Review backend cannot steer the coding agent');
assert.match(reviewPanel, /Send to agent/, 'the operator gets an explicit delivery action');
assert.match(reviewPanel, /confirm\('Send this recommendation/, 'delivery asks for explicit confirmation');
assert.match(reviewPanel, /api\/session\/\$\{P\.sessionId\}\/input/, 'delivery uses the normal operator input route');

assert.doesNotMatch(settings, /id="st-permissions"/, 'Settings does not repeat permission definitions');
assert.doesNotMatch(session, /permission-impact|permission-scope/, 'the composer permission control stays compact');
assert.doesNotMatch(session, /titleTags|model · effort · autonomy|first session running/,
  'the session header does not repeat composer configuration or revive the stale onboarding banner');
assert.match(session, /session-actions-menu/, 'rare stop and kill controls live in the session overflow menu');
assert.match(session, /shell\.classList\.toggle\('session-actions-open', open\)/,
  'opening the dots menu elevates its header stacking context');
const toolbarBase = Number(sessionStyles.match(/\.session-toolbar \{ position: relative; z-index: (\d+);/s)?.[1]);
const actionsLayer = Number(sessionStyles.match(/\.session-shell\.session-actions-open \.session-toolbar \{ z-index: (\d+); \}/s)?.[1]);
assert.ok(toolbarBase > 0 && actionsLayer > toolbarBase,
  'the session toolbar (and its open dots-menu) paints above the log surface');
assert.match(session, /composer-settings-toggle/, 'phone keeps one compact run-settings summary in the composer');
// Operator 2026-08-11/12: the Tools menu hid every agent two clicks deep, and the right rail ate view
// width. The agent menu is a one-click labelled tab strip in the HEADER (three panels: sidenav ·
// session · agent panel); the panel PARKS — open/closed state AND per-tab width persist everywhere.
const host = read('web/agents/host.js');
assert.match(session, /class="agent-tab-strip" id="side-tabs"/, 'the agent menu is a header tab strip, not a side rail');
assert.match(session, /class="session-toolbar"/, 'the view switch + session actions live at the top of the session column');
assert.match(host, /dock-glyph-label/, 'the agent strip shows labelled one-click entries (decodable, no menu hop)');
assert.doesNotMatch(host, /dock-tools-menu/, 'no intermediate Tools menu gates the agent panels');
assert.match(host, /aios_dock_parked/, 'the panel parks: open/closed state persists across sessions');
assert.match(host, /localStorage\.getItem\(PREF_PARKED\) === '1'/, 'a parked panel is restored on mount');
assert.match(host, /onTabChange\(id\)/, 'the host reports the active tab so the session view can restore its width');
assert.match(session, /PREF_PANEL_FRACTIONS/, 'panel width parks per tab');
assert.match(session, /panelFractions\[activeSideTab\] = /, 'drag-resize saves the width under the active tab');

console.log('supercalm_surfaces.test ok');
