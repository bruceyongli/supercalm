// The app-shell sidebar markup is hand-duplicated in THREE places for first-paint: shell.js's canonical
// SIDEBAR_HTML (injected into system pages), and the static copies in web/desktop.html + web/session.html.
// They drifted once — desktop.html kept the pre-redesign "Inbox" nav + "+ New session" button while the
// others moved to "Sessions" — so the dashboard showed a different sidebar than every other page (operator:
// "two UIs … two sidebars … bad codebase management"). This test fails the moment any copy drifts again.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../web/' + p, import.meta.url), 'utf8');
const sidebarOf = (html) => (html.match(/<aside class="dk-side"[\s\S]*?<\/aside>/) || [''])[0];

const shellSidebar = (read('shell.js').match(/const SIDEBAR_HTML = `([\s\S]*?)`;/) || [, ''])[1];
const copies = {
  'shell.js SIDEBAR_HTML': shellSidebar,
  'desktop.html': sidebarOf(read('desktop.html')),
  'session.html': sidebarOf(read('session.html')),
};

const NAV = ['inbox', 'projects', 'decisions', 'records', 'usage', 'health', 'settings'];
for (const [name, sb] of Object.entries(copies)) {
  assert.ok(sb && sb.length > 100, `${name}: dk-side sidebar found`);
  // the redesign: "Sessions" nav, NOT the old "Inbox" label or "+ New session" sidebar button
  assert.ok(/Sessions\s*<span class="dk-badge/.test(sb), `${name}: uses the "Sessions" nav label`);
  assert.ok(!/data-nav="inbox">Inbox\b/.test(sb), `${name}: must not use the old "Inbox" nav label`);
  assert.ok(!/class="dk-new"/.test(sb) && !/\+\s*New session/.test(sb), `${name}: must not have the old "+ New session" sidebar button`);
  assert.ok(/id="dk-sess-plus"/.test(sb), `${name}: has the Sessions "+" launcher (dk-sess-plus)`);
  // every nav item present in every copy (no page missing a section)
  for (const nav of NAV) assert.ok(new RegExp(`data-nav="${nav}"`).test(sb), `${name}: has the ${nav} nav item`);
}

// the SYSTEM nav order/labels must match across copies (catches partial edits)
const systemLabels = (sb) => (sb.match(/data-nav="(decisions|records|usage|health|settings)"[^>]*>([^<]+)/g) || []).map((x) => x.replace(/\s+/g, ' ').trim());
const ref = systemLabels(copies['shell.js SIDEBAR_HTML']);
for (const [name, sb] of Object.entries(copies)) {
  assert.deepEqual(systemLabels(sb), ref, `${name}: SYSTEM nav matches the canonical`);
}

console.log('sidebar_consistency: all 3 sidebar copies match the canonical (no Inbox/+New drift)');
