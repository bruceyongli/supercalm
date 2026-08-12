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
const actionsLayer = Number(sessionStyles.match(/\.session-shell\.session-actions-open > header\s*\{[^}]*z-index:\s*(\d+)/s)?.[1]);
const railLayer = Number(sessionStyles.match(/\.agent-dock-rail\s*\{[^}]*z-index:\s*(\d+)/s)?.[1]);
assert.ok(actionsLayer > railLayer,
  'the open dots-menu header paints above the agent rail stacking layer');
assert.match(session, /composer-settings-toggle/, 'phone keeps one compact run-settings summary in the composer');
// Operator 2026-08-11: the Tools menu hid every agent two clicks deep. The rail is one-click labelled
// entries, and the drawer PARKS — its open/closed state persists across sessions and reloads.
const host = read('web/agents/host.js');
assert.match(host, /dock-glyph-label/, 'the agent rail shows labelled one-click entries (decodable, no menu hop)');
assert.doesNotMatch(host, /dock-tools-menu/, 'no intermediate Tools menu gates the agent panels');
assert.match(host, /aios_dock_parked/, 'the drawer parks: open/closed state persists across sessions');
assert.match(host, /localStorage\.getItem\(PREF_PARKED\) === '1'/, 'a parked drawer is restored on mount');

console.log('supercalm_surfaces.test ok');
