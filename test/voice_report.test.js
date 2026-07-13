// Voice reports — the polish-then-speak pipeline behind the story view's "listen" button.
// Pure-function tests with an injected LLM call (voice_brief.test.js pattern); no server boot.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-vr-'));
const { targetFor, extractAgentScript, splitParts, validateScript, buildScript, SYS_VOICE_REPORT, PROMPT_VERSION } =
  await import('../src/voice_report.js');

// ---- length target scales with the source (the compression IS the "voice version") ----
assert.equal(targetFor(200).maxWords, 120);
assert.equal(targetFor(3000).maxWords, 250);
assert.equal(targetFor(9000).maxWords, 450);
assert.equal(targetFor(9000, 'brief').maxWords, 80, 'brief = fixed ~30s digest regardless of size');
assert.match(SYS_VOICE_REPORT, /SPOKEN report script/);
assert.match(SYS_VOICE_REPORT, /never say URLs, absolute paths/i);
assert.ok(PROMPT_VERSION, 'prompt version exists (cache-key component)');

// ---- agent-authored "Voice report" section short-circuits the LLM ----
{
  const s = extractAgentScript('Did the work.\n\n## Voice report\nHey, quick update: the sidebar refactor landed and all tests pass. That is the report.');
  assert.match(s, /^Hey, quick update/, 'section taken verbatim');
  const bare = extractAgentScript('Did the work.\nVoice report\nHere is the spoken version of everything I did today, in plain sentences.');
  assert.match(bare, /^Here is the spoken version/, 'works after deMd stripped the ##');
  assert.equal(extractAgentScript('## Voice report\nshort'), null, 'too-short section ignored');
  assert.equal(extractAgentScript('no marker here'), null);
}

// ---- splitParts: transport chunks ≤ max, sentence-boundary, giant unbroken text hard-sliced ----
{
  const sentences = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} carries a bit of report substance.`).join(' ');
  const parts = splitParts(sentences);
  assert.ok(parts.length > 1, 'long script splits');
  // default part cap must stay well under the client players' scaled caps (~45-60s of audio each) —
  // 1800-char parts overran the old fixed 90s caps and caused the replay-from-the-top bug
  for (const p of parts) assert.ok(p.length <= 900, 'every part under the default cap');
  for (const p of parts.slice(0, -1)) assert.match(p, /\.$/, 'parts end on sentence boundaries');
  assert.equal(splitParts('One short line.').length, 1);
  const giant = splitParts('y'.repeat(5000));
  assert.ok(giant.every((p) => p.length <= 900), 'unbroken text is hard-sliced under the cap');
}

// ---- validateScript: fences stripped, markdown-heavy + runaway rejected ----
{
  const ok = validateScript('```\nQuick update. The cache fix shipped and the tests pass. That is the report.\n```', 120);
  assert.match(ok, /^Quick update\./);
  assert.ok(!ok.includes('```'));
  assert.equal(validateScript('## Status\n- did a thing\n- did another\n| a | b |', 120), null, 'markdown listing rejected');
  assert.equal(validateScript('word '.repeat(400), 120), null, 'runaway length rejected');
  assert.equal(validateScript('', 120), null);
}

// ---- buildScript: polished path, agent short-circuit, fail-open, deadline race + late cache hook ----
{
  const good = 'The refactor is done and verified. First, I unified the sidebar. Then I ran the tests; all green. That\'s the report.';
  const r = await buildScript('Long written report about the sidebar refactor. '.repeat(20), 'full', { call: async () => ({ content: good, model: 'test-model' }) });
  assert.equal(r.source, 'llm');
  assert.equal(r.polished, true);
  assert.equal(r.model, 'test-model');
  assert.match(r.script, /^The refactor is done/);

  let called = false;
  const a = await buildScript('stuff\n## Voice report\nSpoken version straight from the agent, long enough to count as real.', 'full', { call: async () => { called = true; return { content: good }; } });
  assert.equal(a.source, 'agent');
  assert.equal(called, false, 'agent section skips the LLM');
  const ab = await buildScript('stuff\n## Voice report\nSpoken version straight from the agent, long enough to count as real.', 'brief', { call: async () => ({ content: good, model: 'm' }) });
  assert.equal(ab.source, 'llm', 'a brief request still polishes — the agent script serves the FULL listen only');

  const f = await buildScript('Report with a link https://x.co/y and /Users/bb1/aios/file.js in it. '.repeat(10), 'full', { call: async () => { throw new Error('down'); } });
  assert.equal(f.source, 'sanitized');
  assert.equal(f.polished, false);
  assert.ok(!f.script.includes('https://'), 'fail-open text is sanitized');

  // slow LLM: deadline fails open NOW, the late result still reaches onLate (background cache write)
  let late = null;
  const slowCall = () => new Promise((res) => setTimeout(() => res({ content: good, model: 'slow' }), 120));
  const d = await buildScript('x '.repeat(400), 'full', { call: slowCall, deadlineMs: 30, onLate: (r2) => { late = r2; } });
  assert.equal(d.source, 'sanitized', 'deadline beats the slow polish');
  await new Promise((res) => setTimeout(res, 200));
  assert.ok(late && late.source === 'llm' && late.model === 'slow', 'late polish delivered to onLate');
}

console.log('voice_report.test ok');
