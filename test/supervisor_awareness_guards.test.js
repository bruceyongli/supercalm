import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
const docMaintainer = readFileSync(new URL('../src/agents/doc_maintainer.js', import.meta.url), 'utf8');

assert.match(src, /QUESTION_ONLY_RX/);
assert.match(src, /OPERATOR_WAIT_RX/);
assert.match(src, /OPERATOR_CONTINUE_RX/);
assert.match(src, /latestOperatorIntent/);
assert.match(src, /operatorIntent\?\.kind === 'wait'/);
assert.match(src, /operatorIntent\?\.kind === 'question_only' && s\.category === 'review'/);
assert.match(src, /Operator asked for an answer only, so no completion challenge was sent/);
assert.match(src, /operatorIntent\?\.kind !== 'question_only' && await maybeRecoverApiError/);
assert.match(src, /operatorIntent\?\.kind !== 'question_only' && await maybeRecoverContextWedge/);
assert.match(src, /ran out of room in \(the \)\?model'\?s context window/);
assert.match(src, /recover\.codex_context_clear/);
assert.match(src, /command: '\/clear'/);
assert.match(src, /recover\.codex_context_handoff/);
assert.match(src, /preserve its exact path or URL/);
assert.match(src, /later doc\/spec\/file\/path\/URL supersedes an earlier article/);
assert.match(src, /checkpoint\.corrective_push/);
assert.match(src, /hourly_checkpoint_gap/);
assert.match(src, /sendOptions: \{ guarded: false, blockDecision: false \}/);
assert.match(src, /currentOperatorRequirements/);
assert.match(src, /current_operator_requirements/);
assert.match(src, /OPERATOR LATEST WORDS WIN/);
assert.match(src, /passcode required/);
assert.match(src, /authentication_error/);
assert.match(src, /operator\.settle_after_reanalysis/);
assert.match(src, /lastOperatorDocAttemptTs/);
assert.match(src, /formatOperatorRequirements\(currentOperatorRequirements\(sig\)\)/);
assert(src.indexOf('OPERATOR REANALYSIS MUST PRECEDE SETTLE') < src.indexOf('GENERAL SETTLE'), 'operator reanalysis must happen before settle silence');
assert.match(docMaintainer, /CURRENT_OPERATOR_REQUIREMENTS/);
assert.match(docMaintainer, /mandatory current sign-off gates/);

assert.match(src, /gateScopeKey/);
assert.match(src, /GATE_REPEAT_COOLDOWN_MS/);
assert.match(src, /gateSentKey: gateKey/);
assert.match(src, /verifiedGateKey: gateKey/);
assert.match(src, /signoffStillSettled/);
assert.match(src, /shared workspace/);
assert.doesNotMatch(src, /patch\.verifiedWorkFp\s*=\s*null/);

assert.match(src, /GOAL_CONFLICT_RESYNC_AFTER/);
assert.match(src, /goalConflictResyncedKey/);
assert.match(src, /goal-conflict-resync/);
assert.match(src, /needsOperatorHold: \{ at: now\(\), reason: 'goal_conflict', workFp: fp\.work, gateKey \}/);

const hardErr = src.match(/const HARD_ERR_RX = ([^\n]+);/)?.[1] || '';
assert(!hardErr.includes('request failed'), 'diagnostic app text "request failed" must not trigger session API-error recovery');

console.log('supervisor_awareness_guards.test ok');
