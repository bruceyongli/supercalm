// apply_fixes_r4.mjs — deterministic applier, same contract as r3 (dry-run default, all-or-nothing,
// .r4bak backups). Run from the repo root:
//   node fixpack-r4/apply_fixes_r4.mjs
//   node fixpack-r4/apply_fixes_r4.mjs --apply
//
// 1. Replaces src/story.js with the r4 parser (F10–F13: fail titles, XML strip, de-markdown,
//    humanized tool steps, 1-step meta).
// 2. Patches web/story-view.js:
//    - rollup(): "active" becomes the SUM of ≤10-min gaps (a week-old transcript is not
//      "199.2 hr active"), snags/checks count only since your last message ("97 unresolved
//      fails" gone), asks unchanged.
//    - 1-step expander label reads "show the command".
// If an anchor is missing (the agent edited that function since), NOTHING is written and the
// failing anchor is printed — paste it back to the designer for re-anchoring.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const APPLY = process.argv.includes('--apply');

const ROLLUP_OLD = `function rollup(evs) {
  const first = evs.find((e) => e.ts)?.ts, last = [...evs].reverse().find((e) => e.ts)?.ts;
  const mins = first && last ? Math.max(1, Math.round((last - first) / 60000)) : 0;
  const files = new Set();
  for (const e of evs) if (e.kind === 'edit') for (const c of e.chips || []) files.add(String(c).split(' ')[0]);
  const checks = evs.filter((e) => e.kind === 'check');
  const fails = evs.filter((e) => e.kind === 'fail' && !/recovered/.test(e.meta || ''));
  const asks = evs.filter((e) => e.kind === 'ask' && !e.answered);
  const parts = [];
  if (mins) parts.push(mins >= 60 ? \`\${Math.round(mins / 6) / 10} hr active\` : \`\${mins} min active\`);
  if (files.size) parts.push(\`\${files.size} file\${files.size > 1 ? 's' : ''} touched\`);
  if (checks.length) parts.push(fails.length ? \`\${fails.length} unresolved fail\${fails.length > 1 ? 's' : ''}\` : 'tests green');
  if (asks.length) parts.push(\`\${asks.length} question\${asks.length > 1 ? 's' : ''} for you\`);
  return parts.join(' · ') || (mins ? \`\${mins} min active · working\` : 'session starting');
}`;

const ROLLUP_NEW = `function rollup(evs) {
  // r4: "active" = sum of ≤10-min gaps between events (wall-clock age is not activity);
  // snags/checks count only since the operator's last message (this round, not all history).
  let active = 0, prev = 0;
  for (const e of evs) {
    if (!e.ts) continue;
    if (prev && e.ts > prev && e.ts - prev <= 600000) active += e.ts - prev;
    prev = e.ts;
  }
  const mins = Math.round(active / 60000);
  const lastYou = evs.map((e) => e.kind).lastIndexOf('you');
  const recent = evs.slice(lastYou + 1);
  const files = new Set();
  for (const e of recent) if (e.kind === 'edit') for (const c of e.chips || []) files.add(String(c).split(' ')[0]);
  const fails = recent.filter((e) => e.kind === 'fail').length;
  const checks = recent.filter((e) => e.kind === 'check').length;
  const asks = evs.filter((e) => e.kind === 'ask' && !e.answered);
  const parts = [];
  if (mins) parts.push(mins >= 90 ? \`\${Math.round(mins / 6) / 10} hr active\` : \`\${mins} min active\`);
  if (files.size) parts.push(\`\${files.size} file\${files.size > 1 ? 's' : ''} touched this round\`);
  if (fails) parts.push(\`\${fails} snag\${fails > 1 ? 's' : ''} this round\`);
  else if (checks) parts.push('checks green');
  if (asks.length) parts.push(\`\${asks.length} question\${asks.length > 1 ? 's' : ''} for you\`);
  return parts.join(' · ') || (mins ? \`\${mins} min active · working\` : 'session starting');
}`;

const patches = [
  {
    file: 'web/story-view.js',
    edits: [
      { find: ROLLUP_OLD, replace: ROLLUP_NEW },
      {
        find: "    <div class=\"story-steps-toggle${open ? ' open' : ''}\" data-story-steps-toggle data-i=\"${i}\">${open ? '▾' : '▸'} ${steps.length} step${steps.length > 1 ? 's' : ''}</div>",
        replace: "    <div class=\"story-steps-toggle${open ? ' open' : ''}\" data-story-steps-toggle data-i=\"${i}\">${open ? '▾' : '▸'} ${steps.length > 1 ? steps.length + ' steps' : 'show the command'}</div>",
      },
    ],
  },
];

const replacements = [{ from: join(here, 'src/story.js'), to: join(root, 'src/story.js') }];

const problems = [];
for (const p of patches) {
  const path = join(root, p.file);
  if (!existsSync(path)) { problems.push(`${p.file}: file not found`); continue; }
  const text = readFileSync(path, 'utf8');
  for (const [i, e] of p.edits.entries()) {
    const n = text.split(e.find).length - 1;
    if (n === 0) problems.push(`${p.file} edit #${i + 1}: anchor NOT FOUND (file drifted)`);
    if (n > 1) problems.push(`${p.file} edit #${i + 1}: anchor matches ${n}×`);
  }
}
for (const r of replacements) {
  if (!existsSync(r.from)) problems.push(`missing fixpack file: ${r.from}`);
  if (!existsSync(r.to)) problems.push(`target not found: ${r.to}`);
}
if (problems.length) { console.error('✗ NOT applied:\n  - ' + problems.join('\n  - ')); process.exit(1); }
if (!APPLY) { console.log('✓ dry-run: all anchors verified. Re-run with --apply.'); process.exit(0); }

for (const r of replacements) { copyFileSync(r.to, r.to + '.r4bak'); copyFileSync(r.from, r.to); console.log(`replaced ${r.to}`); }
for (const p of patches) {
  const path = join(root, p.file);
  copyFileSync(path, path + '.r4bak');
  let text = readFileSync(path, 'utf8');
  for (const e of p.edits) text = text.split(e.find).join(e.replace);
  writeFileSync(path, text);
  console.log(`patched ${p.file}`);
}
console.log('✓ fixpack r4 applied.');
