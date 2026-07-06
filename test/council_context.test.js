import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-council-data-'));

const root = await mkdtemp(join(tmpdir(), 'aios-council-repo-'));
await mkdir(join(root, 'docs', 'wiki'), { recursive: true });
await writeFile(join(root, 'docs', 'wiki', 'supervisor-review.md'), [
  '# Supervisor Review',
  '',
  'UNIQUE_COUNCIL_DOC_CONTEXT_42',
  '',
  'The Supervisor should be refactored into Observe -> Decide -> Act -> Learn -> Explain.',
].join('\n'));

const store = await import('../src/store.js');
const council = await import('../src/agents/council.js');

store.createProject({ id: 'p_council', name: 'Council Fixture', path: root });
store.createSession({
  id: 's_council',
  project_id: 'p_council',
  tool: 'codex',
  tmux: 'aios-council',
  title: 'Council context test',
  status: 'waiting',
});

assert.deepEqual(
  council.extractProjectDocRefs('"""~/aios/docs/wiki/supervisor-agent-full-review-2026-06-25.md'),
  ['~/aios/docs/wiki/supervisor-agent-full-review-2026-06-25.md'],
  'quoted tilde docs/wiki paths are recognized'
);

const opened = council.openThread({ projectId: 'p_council', sessionId: 's_council', title: 'Supervisor review architecture' });
council.renameThread(opened.id, 'Supervisor review architecture');

const calls = [];
const ctx = {
  async getEvidence() {
    return { recent_messages: [], terminal_tail: '' };
  },
  async callModel(messages, opts = {}) {
    calls.push({ messages, opts });
    return {
      model: opts.model,
      content: opts.model === 'model-a' ? 'FIRST_ROUND_ADVISOR_TAKE_17' : 'SECOND_ROUND_ADVISOR_TAKE_29',
    };
  },
};

await council.say(ctx, {
  threadId: opened.id,
  text: `Read ${join(root, 'docs/wiki/supervisor-review.md')} and give architecture suggestions.`,
});

await council.runRound(ctx, { threadId: opened.id, models: ['model-a'] });
const firstPrompt = calls.at(-1).messages.find((m) => m.role === 'user').content;
assert.match(firstPrompt, /REFERENCED PROJECT DOCS/, 'explicit doc references are inlined into Council context');
assert.match(firstPrompt, /docs\/wiki\/supervisor-review\.md/, 'the inlined doc keeps its project-relative path');
assert.match(firstPrompt, /UNIQUE_COUNCIL_DOC_CONTEXT_42/, 'the advisor prompt includes the referenced doc body');

calls.length = 0;
await council.runRound(ctx, { threadId: opened.id, models: ['model-b'] });
const secondPrompt = calls.at(-1).messages.find((m) => m.role === 'user').content;
assert.match(secondPrompt, /ADVISOR model-a/, 'later Council rounds include earlier advisor responses');
assert.match(secondPrompt, /FIRST_ROUND_ADVISOR_TAKE_17/, 'a later advisor can critique or synthesize a prior model response');

console.log('council_context.test ok');
