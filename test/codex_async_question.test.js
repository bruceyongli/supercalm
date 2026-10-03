import assert from 'node:assert/strict';
import { parseSessionLog } from '../src/story.js';
import { codexQuestionCall, questionMirror, questionProjection } from '../src/codex_question.js';
import { extractPendingOptionQuestions, answersPayload } from '../web/attention-options.js';
import { isNeedsYouSession } from '../src/voice_attention.js';

const title = '是否允许临时暂停后台标注、复测后恢复？';
const options = ['允许暂停复测并优化让行（推荐）', '只暂停复测，之后恢复原样', '保持后台标注不变'];
const call = { type: 'function_call', name: 'request_user_input_async', call_id: 'call_async_fixture',
  arguments: JSON.stringify({ questions: [{ title, options }] }) };
const row = (payload, n, type = 'response_item') => JSON.stringify({ timestamp: new Date(1700000000000 + n).toISOString(), type, payload });
const mirror = { type: 'agent_message', phase: 'final_answer', message: `${title}\n${options.map(o => '- ' + o).join('\n')}` };
const ack = { type: 'function_call_output', call_id: call.call_id, output: '{"accepted":true}' };
const native = [row(call, 10), row(mirror, 16, 'event_msg'), row(ack, 130)].join('\n');
const events = parseSessionLog(native);
assert.equal(events.length, 1, 'the CLI final-answer mirror is not a duplicate report');
assert.equal(events[0].kind, 'ask');
assert.equal(events[0].body, title, 'async title is the question, not a missing generic placeholder');
assert.deepEqual(events[0].options.map(o => o.label), options);
assert.equal(events[0].askMode, 'async');
assert.notEqual(events[0].answered, true, 'accepted:true is a delivery acknowledgement, not the human answer');
const questions = extractPendingOptionQuestions(events);
assert.equal(questions[0].askMode, 'async');
assert.equal(answersPayload(questions, new Map([[0, new Set([2])]]))[0].ask_id, call.call_id);
assert.equal(parseSessionLog([row(mirror, 1, 'event_msg'), row(call, 10), row(ack, 130)].join('\n')).length, 1,
  'mirror-before-call ordering also collapses to the structured question');
assert.equal(codexQuestionCall({ ...call, name: 'functions.request_user_input_async' }).mode, 'async');
assert.equal(codexQuestionCall({ ...call, name: 'other_tool' }), null);
assert.equal(codexQuestionCall({ ...call, arguments: 'not-json' }), null);
const answered = parseSessionLog(native + '\n' + row({ type: 'message', role: 'user', content: [{ type: 'input_text', text: options[0] }] }, 1000));
assert.equal(answered[0].answered, true, 'a real operator turn does close the async question');
const blocking = { ...call, name: 'request_user_input', arguments: JSON.stringify({ questions: [{ id: 'scope', header: 'Scope', question: title, options: options.map(label => ({ label })) }] }) };
assert.equal(parseSessionLog([row(blocking, 10), row(ack, 130)].join('\n'))[0].answered, true,
  'old blocking tools still use the durable tool output as the answer');
const reportOnly = parseSessionLog(row(mirror, 16, 'event_msg'));
assert.equal(reportOnly[0].kind, 'report', 'ordinary bullet reports never become questions through text guessing');
const multiple = codexQuestionCall({ ...call, arguments: JSON.stringify({ questions: [{ title, options }, { title: 'Verify which devices?', options: ['Phone', 'iPad'], multiSelect: true }] }) });
assert.equal(multiple.questions[1].multiSelect, true);
assert.match(questionMirror(multiple.questions), /Verify which devices\?/);
const session = { status: 'working', category: 'working', structured_question: JSON.stringify({ ...multiple, ts: 10 }) };
assert.equal(questionProjection(session).pending_input, true);
assert.equal(isNeedsYouSession(session, { unread: 1 }), true, 'working async question is in the same Needs You/voice definition');
assert.equal(isNeedsYouSession(session, { unread: 1, dismissed: true }), false);
assert.equal(isNeedsYouSession({ ...session, status: 'exited' }, { unread: 1 }), false);
console.log('codex_async_question.test ok');
