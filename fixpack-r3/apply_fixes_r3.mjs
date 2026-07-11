// apply_fixes_r3.mjs — deterministic fixpack applier. NO LLM involved: exact-string
// replacements with all-or-nothing semantics. Run from the repo root:
//
//   node fixpack-r3/apply_fixes_r3.mjs          # dry-run: verifies every anchor, changes nothing
//   node fixpack-r3/apply_fixes_r3.mjs --apply  # applies; writes <file>.r3bak backups first
//
// What it does:
//   1. Replaces src/story.js with fixpack-r3/src/story.js (parser fixes F1–F9 — see its header).
//   2. Patches web/story-view.js: gap titles from the parser + re-render when answers/meta
//      change (not just event count).
//   3. Patches web/desktop.css: page h1 26px → 19px (spec: page titles 19/600).
//   4. Patches web/styles.css: base .story-ts 9.5px → 10px (spec).
// Every patch anchors on the file's EXACT current text; if any anchor is missing (file drifted),
// nothing at all is written and the failing anchor is reported.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const APPLY = process.argv.includes('--apply');

const patches = [
  {
    file: 'web/story-view.js',
    edits: [
      {
        find: `    return \`<div class="story-gap" data-story-ev data-kind="gap"><span>\${esc(ev.title || 'quiet stretch')}</span></div>\`;`,
        replace: `    const mins = Math.max(1, Math.round((ev.durationMs || 0) / 60000));
    const fallback = ev.durationMs ? \`quiet for \${mins >= 60 ? Math.round(mins / 6) / 10 + ' hr' : mins + ' min'}\` : 'quiet stretch';
    return \`<div class="story-gap" data-story-ev data-kind="gap"><span>\${esc(ev.title || fallback)}</span></div>\`;`,
      },
      {
        find: `let lastCount = -1;`,
        replace: `let lastSig = '';`,
      },
      {
        find: `    events = r.events || [];
    if (events.length !== lastCount) { lastCount = events.length; render(); }`,
        replace: `    events = r.events || [];
    // re-render when anything user-visible changes: count, answers landing, or a
    // cluster/fail meta update on the last events (count alone left stale ✓/recovered states)
    const sig = events.length + ':' + events.reduce((a, e) => a + (e.answered ? 1 : 0), 0)
      + ':' + events.slice(-3).map((e) => e.meta || '').join('|');
    if (sig !== lastSig) { lastSig = sig; render(); }`,
      },
    ],
  },
  {
    file: 'web/desktop.css',
    edits: [
      {
        find: `.dk-page-head h1 { font-family: 'IBM Plex Sans', sans-serif; font-size: 26px;`,
        replace: `.dk-page-head h1 { font-family: 'IBM Plex Sans', sans-serif; font-size: 19px;`,
      },
    ],
  },
  {
    file: 'web/styles.css',
    edits: [
      {
        find: `.story-ts { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 9.5px; color: #3a4453; margin-top: 4px; }`,
        replace: `.story-ts { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10px; color: #3a4453; margin-top: 4px; }`,
      },
    ],
  },
];

const replacements = [
  { from: join(here, 'src/story.js'), to: join(root, 'src/story.js') },
];

// ---- verify everything first ----
const problems = [];
for (const p of patches) {
  const path = join(root, p.file);
  if (!existsSync(path)) { problems.push(`${p.file}: file not found`); continue; }
  const text = readFileSync(path, 'utf8');
  for (const [i, e] of p.edits.entries()) {
    const n = text.split(e.find).length - 1;
    if (n === 0) problems.push(`${p.file} edit #${i + 1}: anchor NOT FOUND (file drifted — re-audit needed)`);
    if (n > 1) problems.push(`${p.file} edit #${i + 1}: anchor matches ${n}× (must be unique)`);
  }
}
for (const r of replacements) {
  if (!existsSync(r.from)) problems.push(`missing fixpack file: ${r.from}`);
  if (!existsSync(r.to)) problems.push(`replacement target not found (unexpected layout): ${r.to}`);
}
if (problems.length) {
  console.error('✗ NOT applied — resolve first:\n  - ' + problems.join('\n  - '));
  process.exit(1);
}
if (!APPLY) {
  console.log('✓ dry-run: all anchors and files verified. Re-run with --apply to write.');
  process.exit(0);
}

// ---- apply ----
for (const r of replacements) {
  copyFileSync(r.to, r.to + '.r3bak');
  copyFileSync(r.from, r.to);
  console.log(`replaced ${r.to} (backup: .r3bak)`);
}
for (const p of patches) {
  const path = join(root, p.file);
  copyFileSync(path, path + '.r3bak');
  let text = readFileSync(path, 'utf8');
  for (const e of p.edits) text = text.split(e.find).join(e.replace);
  writeFileSync(path, text);
  console.log(`patched ${p.file} (${p.edits.length} edit${p.edits.length > 1 ? 's' : ''}, backup: .r3bak)`);
}
console.log('\n✓ fixpack r3 applied. Smoke-check:');
console.log(`  node --input-type=module -e "import('./src/story.js').then(async m=>{const fs=await import('node:fs');for(const f of fs.readdirSync('data').filter(x=>x.endsWith('.jsonl'))){const ev=m.parseSessionLog(fs.readFileSync('data/'+f,'utf8'));console.log(f, ev.length+' events', 'you='+ev.filter(e=>e.kind==='you').length, 'fail='+ev.filter(e=>e.kind==='fail').length, 'asks answered='+ev.filter(e=>e.kind==='ask'&&e.answered).length+'/'+ev.filter(e=>e.kind==='ask').length)}})"`);
