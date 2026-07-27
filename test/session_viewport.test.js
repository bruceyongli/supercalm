import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sessionViewportLayout } from '../web/session-viewport.js';

assert.deepEqual(
  sessionViewportLayout({
    visualHeight: 480,
    offsetTop: 394,
    baselineHeight: 874,
    inputFocused: true,
  }),
  { keyboardOpen: true, height: 480, top: 394, left: 0 },
  'the keyboard-open shell follows the panned visual viewport',
);

assert.equal(
  sessionViewportLayout({
    visualHeight: 480,
    offsetTop: 394,
    baselineHeight: 874,
    inputFocused: false,
  }).keyboardOpen,
  false,
  'blur releases a stale keyboard-sized viewport instead of leaving a short page',
);

assert.equal(
  sessionViewportLayout({
    visualHeight: 810,
    baselineHeight: 874,
    inputFocused: true,
  }).keyboardOpen,
  false,
  'a small browser-toolbar height change is not mistaken for the keyboard',
);

const session = readFileSync(new URL('../web/session.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
assert.match(session, /installSessionViewportSync\(\{/);
assert.doesNotMatch(session, /shell\.style\.height = Math\.round\(vv\.height\)/,
  'the stale height-only iOS workaround is removed');
assert.match(styles, /\.message-box textarea \{[^}]*font-size: 16px/s,
  'the phone composer prevents iOS input auto-zoom');
assert.match(styles, /grid-template-columns: 40px minmax\(0, 1fr\) 40px 40px/,
  'the phone composer keeps attach, one settings summary, mic, and send on one compact row');
assert.match(session, /composer-settings-toggle/,
  'run configuration stays available from the compact composer instead of repeating in the header');

console.log('session_viewport.test ok');
