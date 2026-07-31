import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-brief-'));
const { sanitizeForSpeech, stripRoutineProcessEvidence, stripRepeatedOrientation, validateBrief, buildVoiceBrief, speakBrief, speakOnTheGoBrief, SYS_BRIEF, buildBriefUserText } = await import('../src/voice_brief.js');

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
{
  const t = sanitizeForSpeech('✔ Fixed phone routing … +23 completed new task?');
  assert.doesNotMatch(t, /✔|\\+23|new task/i, 'visual task-list chrome is never read aloud');
  assert.match(t, /23 more items completed/i, 'the useful completion count remains natural speech');
}
{
  assert.equal(stripRoutineProcessEvidence('All browser checks and 119 suites passed.'), '',
    'routine successful release evidence cannot become the spoken update');
  assert.equal(stripRoutineProcessEvidence('The interruption now preserves the question, and all 119 suites passed.'),
    'The interruption now preserves the question.', 'a real outcome survives beside a stock test footer');
  assert.match(stripRoutineProcessEvidence('Three suites failed because the send button is blocked.'), /failed/,
    'failed verification remains important and audible');
}

// ---- validation clamps + option mapping ------------------------------------------------------------
{
  const b = validateBrief({
    topic: 'Widget cache fix', kind: 'decision', quick: 'Cache fix ready; approve checkout?',
    identity: 'widget-shop/checkout',
    module: 'Checkout cache',
    workstream: 'Safe cache repair',
    request: 'Fix the widget cache and preserve local work.',
    updates: [{ requested: 'widget cache', latest: 'The cache fix passed all tests.' }],
    standard: 'The agent repaired the cache and wants approval for a git checkout that drops two local edits.',
    spoken: 'Widget Shop handles checkout. You asked to fix its cache without losing local work. The fix passed, but checkout would discard two edits, so I need your approval.',
    detail: 'x'.repeat(2000), needs: 'A yes or no on the checkout.',
    options: [{ key: 'y', label: 'Approve checkout', spoken: 'Yes, approve the checkout' }, { key: 'zzzz', label: '' }],
  });
  assert.equal(b.kind, 'decision');
  assert.equal(b.identity, 'widget shop/checkout');
  assert.equal(b.module, 'Checkout cache');
  assert.match(b.spoken, /I need your approval/);
  assert.equal(b.updates.length, 1);
  assert.ok(b.detail.length <= 1200);
  assert.equal(b.options.length, 1);
  assert.equal(validateBrief({ topic: 'x' }), null, 'no standard -> invalid');
  assert.equal(validateBrief({ standard: 'Work is complete.', needs: 'No human input is required.' }).needs, '',
    'a model cannot turn “nothing needed” into a fake attention request');
  assert.match(SYS_BRIEF, /Never say URLs, absolute file paths/);
  assert.match(SYS_BRIEF, /ORIGINAL REQUEST/);
  assert.match(SYS_BRIEF, /CURRENT TASK CONTRACT/);
  assert.match(SYS_BRIEF, /RECENT CONVERSATION/);
  assert.match(SYS_BRIEF, /trusted project lead/i);
  assert.match(SYS_BRIEF, /owner already knows what their project is/i);
  assert.match(SYS_BRIEF, /Never explain the product/i);
  assert.match(SYS_BRIEF, /OUTCOME FIRST/);
  assert.match(SYS_BRIEF, /routine release evidence/i);
  assert.match(SYS_BRIEF, /EACH distinct requested deliverable/);
  assert.match(SYS_BRIEF, /decision\|input\|discussion\|review\|blocked\|progress/);
  const user = buildBriefUserText({
    project: 'shop',
    projectIdentity: 'shop/storefront',
    tool: 'codex',
    category: 'review',
    projectContext: 'Shop is the customer checkout application.',
    taskContext: 'Goal: repair checkout without changing payment providers.',
    recentConversation: 'Operator: Keep Apple Pay working.\nAgent report: Card checkout passes, Apple Pay still fails.',
    originalRequest: 'Fix checkout and improve mobile.',
    latestReport: 'Checkout is fixed; mobile needs approval.',
    screen: '├ raw terminal nonsense should never appear',
  });
  assert.match(user, /ORIGINAL REQUEST:[\s\S]*Fix checkout/);
  assert.match(user, /LATEST REPORT:[\s\S]*Checkout is fixed/);
  assert.match(user, /PROJECT \/ REPOSITORY IDENTITY: shop\/storefront/);
  assert.doesNotMatch(user, /customer checkout application/, 'the automatic brief does not explain the owner’s own product');
  assert.match(user, /CURRENT TASK CONTRACT[\s\S]*repair checkout/);
  assert.match(user, /RECENT CONVERSATION[\s\S]*Apple Pay still fails/);
  assert.doesNotMatch(user, /raw terminal nonsense/, 'automatic voice briefs never ingest the terminal tail');
}

{
  const deDuplicated = stripRepeatedOrientation(
    'AIOS Supercalm. Voice Assistant. Report quality. You asked why the update was vague. It now explains the cause and fix.',
    ['AIOS Supercalm', 'Voice Assistant', 'Report quality'],
  );
  assert.match(deDuplicated, /^You asked why/);
  assert.doesNotMatch(deDuplicated, /AIOS Supercalm|Voice Assistant|Report quality/);
}

// ---- generation with an injected model + template fail-open ---------------------------------------
{
  const call = async () => JSON.stringify({
    topic: 'Deploy approval',
    kind: 'decision',
    identity: 'shop/storefront',
    module: 'Checkout',
    workstream: 'Build 12 deployment',
    request: 'Deploy build 12 and verify checkout.',
    updates: [
      { requested: 'deploy build 12', latest: 'The release candidate is ready.' },
      { requested: 'verify checkout', latest: 'Checkout tests passed.' },
    ],
    quick: 'q',
    standard: 'Approve the deploy of build 12?',
    spoken: 'You asked to deploy build 12 and verify checkout. The candidate is ready and checkout passed. I need your approval to deploy.',
    detail: 'd',
    needs: 'Say whether to deploy.',
    options: [{ key: 'y', label: 'Approve', spoken: 'Yes, deploy it' }],
  });
  const b = await buildVoiceBrief({
    sessionId: 's_t',
    project: 'shop',
    projectIdentity: 'shop/storefront',
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
  assert.match(onTheGo, /^shop\/storefront\. Checkout\. Build 12 deployment\./i);
  assert.match(onTheGo, /candidate is ready and checkout passed/i);
  assert.match(onTheGo, /approval to deploy/i);
  assert.ok(onTheGo.split(/\s+/).length <= 95, 'the first on-the-go pass stays within one bounded spoken brief');
  assert.doesNotMatch(onTheGo, /Deploy approval/, 'on-the-go narration does not repeat the manual Voice title/summary format');
  // cache: second call with identical input returns the same object without invoking
  const b2 = await buildVoiceBrief({ sessionId: 's_t', project: 'shop', projectIdentity: 'shop/storefront', tool: 'codex', category: 'decision', originalRequest: 'Deploy build 12 and verify checkout.', latestReport: 'The release candidate is ready and checkout tests passed.', summary: 'sum', ask: 'ask', screen: '', call: async () => { throw new Error('must not be called'); } });
  assert.equal(b2.topic, 'Deploy approval');
  // fail-open template on model failure
  const b3 = await buildVoiceBrief({ sessionId: 's_t2', project: 'shop', projectIdentity: 'shop/storefront', tool: 'codex', category: 'action', summary: 'fix the login at https://x.co/y now', ask: '', screen: '', call: async () => { throw new Error('down'); } });
  assert.equal(b3.kind, 'input');
  assert.equal(b3.identity, 'shop/storefront');
  assert.ok(!b3.standard.includes('https://'), 'fallback text is sanitized too');
  const b4 = await buildVoiceBrief({ sessionId: 's_t3', project: 'shop', projectIdentity: 'shop/storefront', tool: 'codex', category: 'review', originalRequest: 'Fix the voice report.', latestReport: 'All browser checks and 119 suites passed.', call: async () => { throw new Error('down'); } });
  assert.doesNotMatch(b4.spoken, /119|suites passed/i, 'the fail-open path also refuses to report release ceremony as the outcome');
  assert.match(b4.spoken, /not how the requested issue changed/i);
}

{
  const long = speakOnTheGoBrief({
    spoken: Array(140).fill('integrated update').join(' '),
    request: Array(40).fill('requested detail').join(' '),
    quick: Array(40).fill('reported outcome').join(' '),
    standard: 'must not replace quick',
    updates: Array.from({ length: 6 }, (_, index) => ({ requested: `deliverable ${index}`, latest: `long outcome ${index}` })),
    needs: Array(30).fill('operator decision').join(' '),
    options: [],
  });
  assert.ok(long.split(/\s+/).length <= 95, 'even malformed model output cannot become a long automatic monologue');
  assert.doesNotMatch(long, /deliverable 5|long outcome 5/, 'per-deliverable details remain available only on request');
}

console.log('voice_brief.test ok');
