import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-brief-'));
const { sanitizeForSpeech, validateBrief, buildVoiceBrief, speakBrief, SYS_BRIEF } = await import('../src/voice_brief.js');

// ---- the sanitizer kills exactly the unspeakable junk the operator named --------------------------
{
  const t = sanitizeForSpeech(
    'Check https://bb1.example.ts.net/aios/session?id=s_1 and /Users/bb1/openhand/share/codex_cf_macos_hermes.md now.\n' +
    '✻ Sautéed for 12m\n47% context used · esc to interrupt\nDeploy touched deadbeefcafe1234567890 for agents'
  );
  assert.ok(!t.includes('https://'), 'URLs gone');
  assert.match(t, /a link/);
  assert.ok(!t.includes('/Users/'), 'absolute paths gone');
  assert.match(t, /codex_cf_macos_hermes\.md/, 'file name kept');
  assert.ok(!/context used/.test(t), 'context footer gone');
  assert.ok(!/Sautéed/.test(t), 'spinner line gone');
  assert.ok(!/for agents/.test(t), 'footer phrase gone');
  assert.match(t, /an id/, 'long hex replaced');
}

// ---- validation clamps + option mapping ------------------------------------------------------------
{
  const b = validateBrief({
    topic: 'Widget cache fix', kind: 'decision', quick: 'Cache fix ready; approve checkout?',
    standard: 'The agent repaired the cache and wants approval for a git checkout that drops two local edits.',
    detail: 'x'.repeat(2000), needs: 'A yes or no on the checkout.',
    options: [{ key: 'y', label: 'Approve checkout', spoken: 'Yes, approve the checkout' }, { key: 'zzzz', label: '' }],
  });
  assert.equal(b.kind, 'decision');
  assert.ok(b.detail.length <= 900);
  assert.equal(b.options.length, 1);
  assert.equal(validateBrief({ topic: 'x' }), null, 'no standard -> invalid');
  assert.match(SYS_BRIEF, /Never say URLs, absolute file paths/);
  assert.match(SYS_BRIEF, /decision\|input\|discussion\|review\|blocked\|progress/);
}

// ---- generation with an injected model + template fail-open ---------------------------------------
{
  const call = async () => JSON.stringify({ topic: 'Deploy approval', kind: 'decision', quick: 'q', standard: 'Approve the deploy of build 12?', detail: 'd', needs: 'Yes or no.', options: [{ key: 'y', label: 'Approve', spoken: 'Yes, deploy it' }] });
  const b = await buildVoiceBrief({ sessionId: 's_t', project: 'shop', tool: 'codex', category: 'decision', summary: 'sum', ask: 'ask', screen: '', call });
  assert.equal(b.topic, 'Deploy approval');
  const spoken = speakBrief(b);
  assert.match(spoken, /Deploy approval\./);
  assert.match(spoken, /Options: y, Yes, deploy it\./);
  // cache: second call with identical input returns the same object without invoking
  const b2 = await buildVoiceBrief({ sessionId: 's_t', project: 'shop', tool: 'codex', category: 'decision', summary: 'sum', ask: 'ask', screen: '', call: async () => { throw new Error('must not be called'); } });
  assert.equal(b2.topic, 'Deploy approval');
  // fail-open template on model failure
  const b3 = await buildVoiceBrief({ sessionId: 's_t2', project: 'shop', tool: 'codex', category: 'action', summary: 'fix the login at https://x.co/y now', ask: '', screen: '', call: async () => { throw new Error('down'); } });
  assert.equal(b3.kind, 'input');
  assert.ok(!b3.standard.includes('https://'), 'fallback text is sanitized too');
}

console.log('voice_brief.test ok');
