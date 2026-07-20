import assert from 'node:assert/strict';

// R-2 class (dev-set variants — the HOLDOUT fixture in the lab is graded, never tuned against):
// error vocabulary DISPLAYED as data must not read as a live session error; genuine CLI errors must.
const { looksLikeSessionError, detectSessionError } = await import('../src/agents/supervisor/session_errors.js');

// true positives — real CLI error renderings stay detected
for (const live of [
  '⏺ API Error: terminated',
  '⎿  API Error: 529 overloaded_error',
  'Error: stream disconnect (upstream reset)',
  'API Error: rate_limit_error — retry after 60s',
  '  ✘ server_error: internal failure',
]) {
  assert.equal(looksLikeSessionError(live), true, `live error must detect: "${live}"`);
}

// R-2 dev variants — error text as DISPLAYED DATA must NOT detect
for (const data of [
  '2026-07-17 10:28:20|s_x|kernel-reserved:deploy — API Error: terminated (fixture row)',
  '  assert.equal(classifyErrorType("stream error: reset"), "transient");',
  '{"payload":{"reason":"API Error: 529 overloaded"},"session":"s_lab"}',
  'the review corpus counted 27 lines matching API Error before the kernel landed',
  'grep -n "connection error" src/agents/supervisor.js | head',
]) {
  assert.equal(looksLikeSessionError(data), false, `displayed data must NOT detect: "${data}"`);
}

// end-to-end through detectSessionError: a tail whose only "errors" are data rows -> null
const dataTail = [
  'sqlite> SELECT reason FROM events;',
  'kernel-reserved:deploy — was: API Error: terminated',
  '{"fixture":"stream error: reset"}',
  '❯ composer waiting',
].join('\n');
assert.equal(detectSessionError(dataTail), null, 'a pane full of quoted errors starts no episode');

// ...while a genuine trailing CLI error still does
const liveTail = ['⏺ running tests', '⏺ API Error: 529 overloaded_error'].join('\n');
assert.ok(detectSessionError(liveTail), 'a genuine trailing CLI error still starts an episode');

console.log('session_errors_anchor: all assertions passed');
