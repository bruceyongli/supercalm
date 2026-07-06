import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SYS_ANSWER, SYS_ANSWER_DOD, buildAnswerUserText } from '../src/agents/answer_prompt.js';

const answerPrompt = SYS_ANSWER + '\n' + SYS_ANSWER_DOD;
assert.match(answerPrompt, /future.*sequencing markers/i);
assert.match(answerPrompt, /NOT permanent deferrals/i);
assert.match(answerPrompt, /NOT contradictions/i);
assert.match(answerPrompt, /when ready/i);
assert.match(answerPrompt, /proceed rather than escalate/i);

const answerUserText = buildAnswerUserText({
  definition_of_done: 'Future Goal - LangGraph Runner. Do not start until Goal 1 and Goal 2 are complete.',
});
assert.match(answerUserText, /future\/later\/when ready\/after X are not blockers or contradictions/i);

const supervisorSource = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
assert.match(supervisorSource, /PROGRESSIVE SEQUENCING/);
assert.match(supervisorSource, /not never and not contradiction/);
assert.match(supervisorSource, /Staged sequencing/);
assert.match(supervisorSource, /not automatic blockers or contradictions/);
assert.match(supervisorSource, /future\/when-ready\/next phase is now current/);
assert.match(supervisorSource, /next unblocked sequenced\/future\/when-ready phase/);

const maintainerSource = readFileSync(new URL('../src/agents/doc_maintainer.js', import.meta.url), 'utf8');
assert.match(maintainerSource, /Progressive sequencing rule/);
assert.match(maintainerSource, /not "defer forever"/);
assert.match(maintainerSource, /not a contradiction/);
assert.match(maintainerSource, /next sequenced\/future item becomes valid current work/);

console.log('supervisor_progressive_scope.test ok');
