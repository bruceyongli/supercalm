// verify_story_view.mjs — adversarial design-conformance probe for the story view.
// Run AFTER implementation:  node verify_story_view.mjs http://127.0.0.1:8789/session.html?id=<sid>
// Requires playwright (already used by this repo's verification workflow):  npm i -D playwright
//
// Exits non-zero with a findings list if the implementation drifts from spec.tokens.json.
// The implementing agent is NOT done until this passes — treat findings as bugs, not suggestions.

import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const spec = JSON.parse(readFileSync(new URL('./spec.tokens.json', import.meta.url), 'utf8'));
const url = process.argv[2];
if (!url) { console.error('usage: node verify_story_view.mjs <session-url>'); process.exit(2); }

const findings = [];
const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const hexToRgb = (h) => {
  const m = /^#([0-9a-f]{6})$/i.exec(h); if (!m) return h;
  const n = parseInt(m[1], 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
const canon = (v) => norm(v).replace(/\s+/g, '').replace(/\(\./g, '(0.').replace(/,\./g, ',0.');
const cmpColor = (want, got) => canon(got).startsWith(canon(hexToRgb(want)).slice(0, -1)) || canon(got) === canon(hexToRgb(want)) || canon(got) === canon(want);
const cmpPx = (want, got) => Math.abs(parseFloat(want) - parseFloat(got)) <= 0.5;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(url, { waitUntil: 'load' }); await page.waitForTimeout(6500); // SSE keeps network busy; assertions unchanged

// ---------- 1. DOM contract ----------
const dc = spec.domContract;
for (const [name, sel] of Object.entries(dc)) {
  if (name.startsWith('$') || name === 'kinds' || name === 'eventKindAttr') continue;
  if (!(await page.$(sel))) findings.push(`DOM: missing ${name} → selector ${sel}`);
}
// every rendered event kind must be one of the spec kinds
const kinds = await page.$$eval(dc.event, (els) => els.map((e) => e.getAttribute('data-kind')));
for (const k of kinds) if (k && !dc.kinds.includes(k)) findings.push(`DOM: unknown event kind "${k}"`);
if (!kinds.length) findings.push('DOM: no story events rendered at all');

// ---------- 2. Computed styles (font sizes, colors, radii, element sizes) ----------
for (const [sel, props] of Object.entries(spec.computedStyles)) {
  if (sel.startsWith('$')) continue;
  const el = await page.$(sel);
  if (!el) { findings.push(`STYLE: nothing matches ${sel} (cannot verify)`); continue; }
  const got = await el.evaluate((e, keys) => {
    const cs = getComputedStyle(e); const o = {};
    for (const k of keys) o[k] = cs[k] || (k === 'borderColor' ? cs.borderTopColor : '');
    return o;
  }, Object.keys(props));
  for (const [prop, want] of Object.entries(props)) {
    const g = got[prop];
    const ok = /color/i.test(prop) ? cmpColor(want, g)
      : /(size|height|width|radius)/i.test(prop) && /px$/.test(String(want)) ? cmpPx(want, g)
      : prop === 'lineHeight' ? Math.abs(parseFloat(g) / parseFloat(getComputedFontSize(got)) - parseFloat(want)) < 0.15 || cmpPx(want, g)
      : norm(g).includes(norm(want));
    if (!ok) findings.push(`STYLE: ${sel} { ${prop}: expected ${want}, got ${g} }`);
  }
}
function getComputedFontSize(o) { return o.fontSize || '13px'; }

// ---------- 3. Interactions (the part agents skip) ----------
// 3a. toggle: story <-> terminal actually swaps panels
await page.click(`${spec.domContract.toggleTerminal}`);
if (await page.$eval(spec.domContract.panel, (e) => !!e.offsetParent).catch(() => false))
  findings.push('INTERACTION: terminal mode still shows the story panel');
await page.click(`${spec.domContract.toggleStory}`);
if (!(await page.$eval(spec.domContract.panel, (e) => !!e.offsetParent).catch(() => false)))
  findings.push('INTERACTION: switching back to story does not restore the panel');

// 3b. steps expander opens and closes
const exp = await page.$(spec.domContract.stepsExpander);
if (!exp) findings.push('INTERACTION: no steps expander rendered');
else {
  await exp.click();
  if (!(await page.$(spec.domContract.stepsBody))) findings.push('INTERACTION: expander click does not reveal steps');
  else {
    await exp.click();
    if (await page.$eval(spec.domContract.stepsBody, (e) => !!e.offsetParent).catch(() => false))
      findings.push('INTERACTION: expander does not collapse again');
  }
}

// 3c. ask buttons exist for unanswered asks and POST to the input endpoint
const askOpt = await page.$(spec.domContract.askOptions);
if (askOpt) {
  const [req] = await Promise.all([
    page.waitForRequest((r) => /\/api\/session\/.+\/(input|type)/.test(r.url()) && r.method() === 'POST', { timeout: 3000 }).catch(() => null),
    askOpt.click(),
  ]);
  if (!req) findings.push('INTERACTION: ask option click did not POST to the session input endpoint');
}

// 3d. hover state on expander (color change proves style-hover was implemented)
if (exp) {
  const before = await exp.evaluate((e) => getComputedStyle(e).color);
  await exp.hover();
  const after = await exp.evaluate((e) => getComputedStyle(e).color);
  if (before === after) findings.push('INTERACTION: steps expander has no hover state');
}

// 3e. persistence: reload keeps the chosen mode
await page.click(spec.domContract.toggleTerminal);
await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(5000);
if (await page.$eval(spec.domContract.panel, (e) => !!e.offsetParent).catch(() => false))
  findings.push('INTERACTION: log-view choice does not persist across reload');

await browser.close();

if (findings.length) {
  console.error(`\n✗ ${findings.length} conformance finding(s):\n` + findings.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log('✓ story view conforms to spec.tokens.json (DOM, styles, interactions)');
