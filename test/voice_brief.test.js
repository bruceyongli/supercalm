import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-brief-'));
const { sanitizeForSpeech, validateBrief, buildVoiceBrief, speakBrief, speakOnTheGoBrief, SYS_BRIEF, buildBriefUserText } = await import('../src/voice_brief.js');

// ---- the sanitizer kills exactly the unspeakable junk the operator named --------------------------
{
  const t = sanitizeForSpeech(
    'Check https://bb1.example.ts.net/aios/session?id=s_1 and /Users/bb1/openhand/share/codex_cf_macos_hermes.md now.\n' +
    '✻ Sautéed for 12m\n47% context used · esc to interrupt\nDeploy touched deadbeefcafe1234567890 for agents'
  );
  assert.ok(!t.includes('https://'), 'URLs gone');
  assert.match(t, /a link/);
  assert.ok(!t.includes('/Users/'), 'absolute paths gone');
  assert.match(t, /codex cf macos hermes file/, 'file name becomes ordinary spoken words');
  assert.ok(!/context used/.test(t), 'context footer gone');
  assert.ok(!/Sautéed/.test(t), 'spinner line gone');
  assert.ok(!/for agents/.test(t), 'footer phrase gone');
  assert.match(t, /an id/, 'long hex replaced');
}
{
  const t = sanitizeForSpeech(
    '```js\nconst x = () => { return s_cd261dd8eb; };\n```\n' +
    '├── **Result:** `session_state.ts` now handles foo_bar -> baz-qux.'
  );
  assert.ok(!/const x|cd261|```|├|\*\*|`|->|[_{}]/.test(t), 'source and symbol noise are never handed to TTS');
  assert.match(t, /Result:/);
  assert.match(t, /session state file/, 'a source filename becomes ordinary spoken words');
}

// ---- validation clamps + option mapping ------------------------------------------------------------
{
  const b = validateBrief({
    topic: 'Widget cache fix', kind: 'decision', quick: 'Cache fix ready; approve checkout?',
    request: 'Fix the widget cache and preserve local work.',
    updates: [{ requested: 'widget cache', latest: 'The cache fix passed all tests.' }],
    standard: 'The agent repaired the cache and wants approval for a git checkout that drops two local edits.',
    detail: 'x'.repeat(2000), needs: 'A yes or no on the checkout.',
    options: [{ key: 'y', label: 'Approve checkout', spoken: 'Yes, approve the checkout' }, { key: 'zzzz', label: '' }],
  });
  assert.equal(b.kind, 'decision');
  assert.equal(b.updates.length, 1);
  assert.ok(b.detail.length <= 900);
  assert.equal(b.options.length, 1);
  assert.equal(validateBrief({ topic: 'x' }), null, 'no standard -> invalid');
  assert.match(SYS_BRIEF, /Never say URLs, absolute file paths/);
  assert.match(SYS_BRIEF, /ORIGINAL REQUEST/);
  assert.match(SYS_BRIEF, /EACH distinct requested deliverable/);
  assert.match(SYS_BRIEF, /decision\|input\|discussion\|review\|blocked\|progress/);
  const user = buildBriefUserText({
    project: 'shop',
    tool: 'codex',
    category: 'review',
    originalRequest: 'Fix checkout and improve mobile.',
    latestReport: 'Checkout is fixed; mobile needs approval.',
    screen: '├ raw terminal nonsense should never appear',
  });
  assert.match(user, /ORIGINAL REQUEST:[\s\S]*Fix checkout/);
  assert.match(user, /LATEST REPORT:[\s\S]*Checkout is fixed/);
  assert.doesNotMatch(user, /raw terminal nonsense/, 'automatic voice briefs never ingest the terminal tail');
}

// ---- generation with an injected model + template fail-open ---------------------------------------
{
  const call = async () => JSON.stringify({
    topic: 'Deploy approval',
    kind: 'decision',
    request: 'Deploy build 12 and verify checkout.',
    updates: [
      { requested: 'deploy build 12', latest: 'The release candidate is ready.' },
      { requested: 'verify checkout', latest: 'Checkout tests passed.' },
    ],
    quick: 'q',
    standard: 'Approve the deploy of build 12?',
    detail: 'd',
    needs: 'Say whether to deploy.',
    options: [{ key: 'y', label: 'Approve', spoken: 'Yes, deploy it' }],
  });
  const b = await buildVoiceBrief({
    sessionId: 's_t',
    project: 'shop',
    tool: 'codex',
    category: 'decision',
    originalRequest: 'Deploy build 12 and verify checkout.',
    latestReport: 'The release candidate is ready and checkout tests passed.',
    summary: 'sum',
    ask: 'ask',
    screen: '',
    call,
  });
  assert.equal(b.topic, 'Deploy approval');
  const spoken = speakBrief(b);
  assert.match(spoken, /Deploy approval\./);
  assert.match(spoken, /Options: y, Yes, deploy it\./);
  const onTheGo = speakOnTheGoBrief(b);
  assert.match(onTheGo, /^Here's what happened\./);
  assert.match(onTheGo, /Your original request was: Deploy build 12 and verify checkout\./);
  assert.match(onTheGo, /For deploy build 12, The release candidate is ready\./);
  assert.match(onTheGo, /For verify checkout, Checkout tests passed\./);
  assert.doesNotMatch(onTheGo, /Deploy approval/, 'on-the-go narration does not repeat the manual Voice title/summary format');
  // cache: second call with identical input returns the same object without invoking
  const b2 = await buildVoiceBrief({ sessionId: 's_t', project: 'shop', tool: 'codex', category: 'decision', originalRequest: 'Deploy build 12 and verify checkout.', latestReport: 'The release candidate is ready and checkout tests passed.', summary: 'sum', ask: 'ask', screen: '', call: async () => { throw new Error('must not be called'); } });
  assert.equal(b2.topic, 'Deploy approval');
  // fail-open template on model failure
  const b3 = await buildVoiceBrief({ sessionId: 's_t2', project: 'shop', tool: 'codex', category: 'action', summary: 'fix the login at https://x.co/y now', ask: '', screen: '', call: async () => { throw new Error('down'); } });
  assert.equal(b3.kind, 'input');
  assert.ok(!b3.standard.includes('https://'), 'fallback text is sanitized too');
}

console.log('voice_brief.test ok');
