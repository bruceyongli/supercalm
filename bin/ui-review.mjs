#!/usr/bin/env node
// Vision-model UI review — sends the screenshots captured by bin/mobile-audit.mjs (or any dir of PNGs
// + optional report.json step notes) to a vision-capable model on the local proxy fleet and prints a
// structured findings list. The reviewer model sees exactly what a user sees, per screen, and returns
// strict JSON; findings are aggregated across batches and saved next to the shots as review.json.
//   node bin/ui-review.mjs [--dir /tmp/mobile-audit] [--model gpt-5.6-sol] [--batch 4]
//                          [--focus "extra instructions"] [--effort medium]
// Self-contained on purpose: resolves the model's port by asking each proxy's /v1/models (no dependence
// on the server's scanned catalog being loaded), auth via the shared fleet key (model_catalog.fleetKey).
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fleetKey } from '../src/model_catalog.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const DIR = opt('dir', '/tmp/mobile-audit');
const MODEL = opt('model', 'gpt-5.6-sol');
const BATCH = Number(opt('batch', 4));
const FOCUS = opt('focus', '');
const EFFORT = opt('effort', 'medium');
const PORTS = [8787, 8788, 8789, 8790, 8791, 8792];

const key = await fleetKey();
async function portFor(model) {
  for (const p of PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const j = await r.json();
      if ((j.data || j.models || []).some((m) => (m.id || m.name) === model)) return p;
    } catch {}
  }
  throw new Error(`model ${model} not found on any proxy port (${PORTS.join(',')})`);
}

const SYS = `You are a meticulous senior mobile UI reviewer doing a visual QA pass on "Supercalm", a dark, monospace, mobile-first web console that supervises CLI coding agents. You are given phone-viewport screenshots (390pt wide), each labeled with a step name and what the step did.

Report every CONCRETE visual/functional defect you can actually see:
- content overflowing or clipped at screen edges; horizontal scroll symptoms
- overlapping text/controls; elements covering each other
- controls that are cut off, mispositioned, floating in dead space, or detached from their surface
- unreadably small/low-contrast text; truncation that destroys meaning
- tap targets that look smaller than ~40px
- broken/empty panels, raw error text shown to the user
- layout that is obviously desktop-shaped on a phone (tiny columns, cramped grids)
- inconsistent visual language vs the other screens (fonts, radii, spacing, palette)

Do NOT invent issues you cannot see. Do not restyle by taste — defects only. Judge each screen independently.

Return STRICT JSON only:
{"screens":[{"screen":"<step name>","verdict":"ok"|"issues","findings":[{"severity":"high"|"medium"|"low","issue":"<what is wrong, concretely, one sentence>","fix_hint":"<one short suggestion>"}]}]}`;

async function reviewBatch(port, items) {
  // NB the backend REQUIRES the word "json" in the user input to accept response_format json_object.
  const content = [{ type: 'text', text: `Review these ${items.length} phone screenshots and reply with the strict json object described in your instructions. Steps:\n` + items.map((it) => `- ${it.name}: ${it.note || ''}${it.error ? ` [runtime error: ${it.error}]` : ''}`).join('\n') + (FOCUS ? `\n\nExtra focus: ${FOCUS}` : '') }];
  for (const it of items) {
    content.push({ type: 'text', text: `screen: ${it.name}` });
    content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${it.b64}` } });
  }
  const body = { model: MODEL, temperature: 0.1, reasoning_effort: EFFORT, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYS }, { role: 'user', content }] };
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(300000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || j?.error) throw new Error(j?.error?.message || `HTTP ${r.status}`);
  const text = j.choices?.[0]?.message?.content || '';
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in model reply: ' + String(text).slice(0, 200));
  return JSON.parse(m[0]);
}

let steps = [];
try { steps = JSON.parse(await readFile(join(DIR, 'report.json'), 'utf8')).steps || []; } catch {}
const noteOf = new Map(steps.map((s) => [s.name, s]));
const pngs = (await readdir(DIR)).filter((f) => f.endsWith('.png')).sort();
if (!pngs.length) { console.error('no PNGs in ' + DIR); process.exit(1); }
const port = await portFor(MODEL);
console.log(`reviewing ${pngs.length} screenshots with ${MODEL}@${port} (batch ${BATCH}, effort ${EFFORT})…`);

const items = [];
for (const f of pngs) {
  const name = f.replace(/\.png$/, '');
  const st = noteOf.get(name) || {};
  items.push({ name, note: st.note, error: st.error, b64: (await readFile(join(DIR, f))).toString('base64') });
}
const screens = [];
for (let i = 0; i < items.length; i += BATCH) {
  const batch = items.slice(i, i + BATCH);
  process.stdout.write(`  batch ${1 + i / BATCH}/${Math.ceil(items.length / BATCH)} (${batch.map((b) => b.name).join(', ')})… `);
  try {
    const r = await reviewBatch(port, batch);
    screens.push(...(r.screens || []));
    console.log('ok');
  } catch (e) {
    console.log('FAILED: ' + e.message);
    screens.push(...batch.map((b) => ({ screen: b.name, verdict: 'review-failed', findings: [], error: e.message })));
  }
}

const out = { model: MODEL, dir: DIR, at: new Date().toISOString(), screens };
await writeFile(join(DIR, 'review.json'), JSON.stringify(out, null, 2));
const flat = screens.flatMap((s) => (s.findings || []).map((f) => ({ screen: s.screen, ...f })));
const rank = { high: 0, medium: 1, low: 2 };
flat.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
console.log(`\n${flat.length} finding(s) across ${screens.filter((s) => s.verdict === 'issues').length}/${screens.length} screens → ${join(DIR, 'review.json')}\n`);
for (const f of flat) console.log(`  [${(f.severity || '?').toUpperCase().padEnd(6)}] ${f.screen}: ${f.issue}${f.fix_hint ? `  → ${f.fix_hint}` : ''}`);
