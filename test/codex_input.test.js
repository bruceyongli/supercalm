import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexOwnedPaste, codexPaste } from '../src/codex_composer.js';
import { pendingComposerDraft } from '../src/agent_input_ready.js';
import { submitAgentComposer } from '../src/agent_submit.js';
import { createCodexInputReceipt } from '../src/codex_input_receipt.js';

const text = Array.from({ length: 45 }, (_, i) => `第${i}行 请保留全部信息，截图与路径也不能丢失。`).join('\n');
const suffix = text.split('\n').slice(-10).join('\n  ');
const idle = '› Ask Codex to do anything\n\nGPT-6.1-Sol max';
const cropped = `\n\n› ${suffix}\n\nGPT-6.1-Sol max\n`;
const draft = pendingComposerDraft(cropped, { requireFooter: true, maxLines: 120, preserveWraps: true, expectedText: text });
assert.ok(codexOwnedPaste({ draft, beforeDraft: null, text, screen: cropped }));
assert.equal(codexOwnedPaste({ draft, beforeDraft: draft, text, screen: cropped }), false, 'an old partial draft cannot authorize a send');
assert.equal(codexOwnedPaste({ draft, text: text + 'different tail', screen: cropped }), false);
assert.equal(codexOwnedPaste({ draft, text, screen: '\n'.repeat(8) + cropped }), false, 'a short composer low on the screen is not viewport clipping');
assert.equal(codexOwnedPaste({ draft: { text: '[Pasted Content 7 chars]' }, text: '中文😀test' }), true);
assert.equal(codexOwnedPaste({ draft: { text: '[Pasted Content 6 chars]' }, text: '中文😀test' }), false, 'partial folded paste cannot authorize Enter');
assert.equal(codexPaste('a\nb'), '\x1b[200~a\nb\x1b[201~');
let time = 0, enters = 0;
let result = await submitAgentComposer({ text, before: idle, ownedPaste: codexOwnedPaste,
  clock: () => time, pause: async ms => { time += ms; },
  readScreen: async () => enters ? idle : cropped, pressEnter: async () => { enters++; } });
assert.equal(result.accepted, true); assert.equal(enters, 1);
time = 0; enters = 0;
result = await submitAgentComposer({ text, before: idle, ownedPaste: codexOwnedPaste,
  clock: () => time, pause: async ms => { time += ms; }, inputUnchanged: () => time < 400,
  readScreen: async () => cropped, pressEnter: async () => { enters++; } });
assert.equal(result.accepted, false); assert.equal(enters, 0, 'human edit invalidates owned cropped paste before Enter');

const dir = await mkdtemp(join(tmpdir(), 'aios-codex-receipt-'));
const file = join(dir, 'history.jsonl');
process.env.AIOS_CODEX_HISTORY_FILE = file;
const nativeId = '11111111-2222-3333-4444-555555555555';
const record = (overrides = {}) => JSON.stringify({ session_id: nativeId, ts: Date.now() / 1000, text, ...overrides }) + '\n';
try {
  await writeFile(file, record());
  const read = await createCodexInputReceipt(nativeId, text);
  assert.equal(await read(), null, 'old equal text is not a receipt');
  await appendFile(file, record({ session_id: 'other' }) + record({ text: text + 'changed' }));
  assert.equal(await read(), null, 'only exact conversation and complete contents count');
  const line = record(); await appendFile(file, line.slice(0, -4));
  assert.equal(await read(), null);
  await appendFile(file, line.slice(-4));
  assert.equal((await read()).receipt, 'codex-native-history');
  const restored = await createCodexInputReceipt(nativeId, text, read.cursor);
  assert.equal((await restored()).receipt, 'codex-native-history', 'watermark survives server/browser refresh');
  assert.equal(await createCodexInputReceipt('other', text, read.cursor), null);
  const rotated = await createCodexInputReceipt(nativeId, text);
  await rename(file, join(dir, 'old')); await writeFile(file, record());
  assert.equal(await rotated(), null, 'file replacement never reuses an old receipt');
  time = 0; enters = 0;
  result = await submitAgentComposer({ text, before: idle,
    clock: () => time, pause: async ms => { time += ms; }, confirmSubmission: restored,
    readScreen: async () => cropped, pressEnter: async () => { enters++; } });
  assert.equal(result.accepted, true); assert.equal(enters, 0, 'manual Enter accepted before the first capture needs no second Enter');
} finally { await rm(dir, { recursive: true, force: true }); }
console.log('codex_input: viewport-clipped owned paste, raw-edit fence, exact durable native receipt and no duplicate Enter passed');
