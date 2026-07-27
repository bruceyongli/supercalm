import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-evidence-rule-'));

const store = await import('../src/store.js');
const memory = await import('../src/agents/supervisor/project_memory.js');

store.createProject({ id: 'p_rule', name: 'Rule Project', path: process.cwd() });
store.createSession({
  id: 's_rule',
  project_id: 'p_rule',
  tool: 'codex',
  tmux: 'tmux-rule-test',
  title: 'Evidence rule test',
  status: 'waiting',
  started_at: Date.now(),
});

const text = 'When changing session navigation, verify the rendered phone and desktop layouts before reporting completion.';
const standardId = memory.addStandard('p_rule', text, { sourceRef: 'session:s_rule:event:42', sessionId: 's_rule' });
assert(standardId);
assert.equal(memory.addStandard('p_rule', text.toUpperCase(), { sessionId: 's_rule' }), standardId,
  'exact case-insensitive duplicates reuse one active project rule');

let standards = memory.listStandardsForSession('p_rule', 's_rule');
assert.equal(standards.length, 1);
assert.equal(standards[0].used_in_this_run, 0);
assert.equal(standards[0].reuse_count, 0);

const block = memory.formatProjectStandards('p_rule');
assert.deepEqual(block.ids, [standardId]);
assert.match(block.text, /OPERATOR_PROJECT_RULES/);
assert.match(block.text, /verify the rendered phone and desktop layouts/);

memory.noteStandardsUsed('p_rule', block.ids, { sessionId: 's_rule' });
memory.noteStandardsUsed('p_rule', block.ids, { sessionId: 's_rule' });
standards = memory.listStandardsForSession('p_rule', 's_rule');
assert.equal(standards[0].used_in_this_run, 1);
assert.equal(standards[0].reuse_count, 1, 'one session counts once even if launch bookkeeping retries');

assert.equal(memory.retireStandard('p_rule', standardId), true);
assert.equal(memory.listStandards('p_rule').length, 0);

const story = readFileSync(new URL('../web/story-view.js', import.meta.url), 'utf8');
const inspector = readFileSync(new URL('../web/agents/inspector.js', import.meta.url), 'utf8');
const inspectorMeta = readFileSync(new URL('../src/agents/inspector.js', import.meta.url), 'utf8');
const knowledge = readFileSync(new URL('../web/agents/knowledge.js', import.meta.url), 'utf8');
const sessions = readFileSync(new URL('../src/sessions.js', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../web/views/dashboard.js', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../web/views/settings.js', import.meta.url), 'utf8');

assert.match(story, /data-story-evidence/, 'Story result cards open focused evidence');
assert.match(story, /aios:evidence-learned/, 'Story marks an exception after a rule is saved');
assert.match(inspector, /Exception review/, 'the panel leads with a focused diagnosis instead of another report');
assert.match(inspector, /Next autonomous move/, 'the diagnosis makes the next autonomous action explicit');
assert.match(inspector, /teach\/.+\/retry/, 'the current session can retry with the saved rule');
assert.match(inspectorMeta, /defaultEnabled:\s*false/, 'Evidence is optional and does not occupy the dock by default');
assert.match(knowledge, /Autonomy rules/, 'Knowledge exposes the durable rule ledger');
assert.match(knowledge, /never used/, 'the ledger distinguishes saved rules that never reached a run');
assert.match(sessions, /<project_rules>/, 'future launches receive active project rules');
assert.match(dashboard, /Why it needs you/, 'Needs you links directly into focused diagnosis');
assert.match(settings, /Search settings/, 'Settings has a first-class search control');
assert.match(settings, /id="st-permissions"/, 'Settings explains permission modes as their own category');

console.log('evidence_rule.test ok');
