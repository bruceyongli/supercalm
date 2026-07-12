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
{
  const shell = read('shell.js');
  const rs = shell.indexOf('function renderSide()');
  assert.ok(rs > 0, 'renderSide exists');
  const body = shell.slice(rs, rs + 1800);
  assert.ok(/!== 'working'/.test(body) && /!== 'waiting'/.test(body), 'renderSide keeps a stopped bucket (status is neither working nor waiting)');
  assert.ok(/STOPPED/.test(body), 'renderSide renders a labeled STOPPED section');
  assert.ok(!/slice\(0, 7\)/.test(body), 'renderSide no longer caps to 7 LIVE sessions — that live-only cap is what dropped stopped sessions');
}

console.log('ui_render_invariants: supervisor no-flash guard + sidebar stopped-sessions present');
