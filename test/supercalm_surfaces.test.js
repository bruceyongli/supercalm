import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const session = read('web/session.js');
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
assert.match(session, /composer-settings-toggle/, 'phone keeps one compact run-settings summary in the composer');
assert.match(read('web/agents/host.js'), />Tools</, 'the session exposes one named Tools entry instead of an unlabeled glyph strip');

console.log('supercalm_surfaces.test ok');
