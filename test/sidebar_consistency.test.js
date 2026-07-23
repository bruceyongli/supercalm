// The SPA owns one app-shell document. The only remaining copy is the deliberately separate classic
// dashboard; retired standalone system/session documents are routed back through app.html.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../web/' + p, import.meta.url), 'utf8');
const sidebarOf = (html) => (html.match(/<aside class="dk-side"[\s\S]*?<\/aside>/) || [''])[0];

const copies = {
  'app.html': sidebarOf(read('app.html')), // the LIVE sidebar after the SPA cutover — the one users actually see
  'desktop.html': sidebarOf(read('desktop.html')),
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
const ref = systemLabels(copies['app.html']);
for (const [name, sb] of Object.entries(copies)) {
  assert.deepEqual(systemLabels(sb), ref, `${name}: SYSTEM nav matches the canonical`);
}

console.log(`sidebar_consistency: ${Object.keys(copies).length} intentional shell documents match (SPA + classic; retired standalone copies removed)`);
