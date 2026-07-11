#!/usr/bin/env node
// Design-conformance harness: render each screen of the authoritative prototype
// (Supercalm Desktop.dc.html) and the live production app at a matched viewport, side by side, so
// "matches the design" is a screenshot diff instead of a guess. Prototype path + prod base are args.
//   node scripts/design-diff.mjs "<proto.html>" "http://127.0.0.1:8793" "<sessionId>"
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const PROTO = process.argv[2];
const BASE = process.argv[3] || 'http://127.0.0.1:8793';
const SID = process.argv[4] || '';
const OUT = '/tmp/design-diff';
const VP = { width: 1440, height: 900 };
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();

// ---- Prototype: drive onboarding → app, then screenshot each screen -----------------------------
async function proto() {
  const p = await b.newPage({ viewport: VP });
  await p.goto('file://' + encodeURI(PROTO), { waitUntil: 'load' });
  await p.waitForTimeout(600);
  const clickText = async (t) => { const el = p.getByText(t, { exact: false }).first(); if (await el.count()) { await el.click(); await p.waitForTimeout(350); return true; } return false; };
  await p.screenshot({ path: `${OUT}/proto-01-welcome.png` });
  await clickText('Get started');
  await p.screenshot({ path: `${OUT}/proto-02-onboarding.png` });
  // step 1 → continue; step 2 sign-in: paste + continue; then skip to app
  await clickText('Continue');
  // simulate a paste-login so the gate opens, then finish
  for (const box of await p.locator('textarea, input[type=text]').all()) { try { await box.fill('simulated-oauth-code'); } catch {} }
  await p.waitForTimeout(200);
  await clickText('Complete sign-in') || await clickText('Sign in') || await clickText('Continue');
  await clickText('Start using Supercalm') || await clickText('Finish') || await clickText('Continue');
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${OUT}/proto-03-inbox.png` });
  // open a session
  const sess = p.locator('[class*=session], [class*=sess]').filter({ hasText: /codex|claude|aios|asdas/i }).first();
  if (await sess.count()) { await sess.click(); await p.waitForTimeout(700); }
  await p.screenshot({ path: `${OUT}/proto-04-session.png` });
  await p.close();
}

// ---- Production: same viewport, the pages that exist today ---------------------------------------
async function prod() {
  const p = await b.newPage({ viewport: VP });
  const grab = async (path, name) => { try { await p.goto(BASE + path, { waitUntil: 'load' }); await p.waitForTimeout(2500); await p.screenshot({ path: `${OUT}/prod-${name}.png` }); } catch (e) { console.log('prod', name, 'err', e.message); } };
  await grab('/', '03-inbox');
  if (SID) await grab('/session?id=' + SID, '04-session');
  await p.close();
}

await proto();
await prod();
await b.close();
console.log('screens in ' + OUT + ': proto-0{1..4}, prod-03/04');
