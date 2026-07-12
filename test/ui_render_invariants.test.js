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
  const inbox = desk.slice(ri, ri + 4200);
  assert.ok(/!== 'working'/.test(inbox) && /!== 'waiting'/.test(inbox), 'renderInbox keeps a stopped bucket for the page body');
  assert.ok(/STOPPED/.test(inbox), 'renderInbox renders a STOPPED section in the page body (#dk-rows)');
  assert.ok(/dk-rows/.test(inbox), 'the STOPPED section targets the page-body #dk-rows list');
}

// ONE unified sidebar width: both shells derive from a single --rail-width token so the dashboard and
// session rails can't drift to two widths again (operator: "why maintain two sidebars … different width").
{
  const dcss = read('desktop.css');
  assert.ok(/--rail-width\s*:/.test(dcss), 'desktop.css defines the shared --rail-width token');
  assert.ok(/\.dk-shell\s*\{[^}]*grid-template-columns:\s*var\(--rail-width\)/.test(dcss), '.dk-shell rail width uses var(--rail-width)');
  const scss = read('styles.css');
  assert.ok(/--session-rail-width:\s*var\(--rail-width/.test(scss), 'the session shell derives its rail width from the shared --rail-width token');
}

console.log('ui_render_invariants: no-flash guard + stopped-in-page-body + one unified rail width');
