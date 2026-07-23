import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answersPayload, extractPendingOptionQuestions } from '../web/attention-options.js';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

// The inbox takes only the newest still-pending structured prompt and keeps every question in that
// prompt. Earlier answered/stale asks never reappear beside the current choices.
{
  const events = [
    { kind: 'ask', ts: 1, askId: 'old', body: 'Old?', options: [{ label: 'Old option' }] },
    { kind: 'ask', ts: 2, askId: 'new', title: 'Needs your decision — Runtime', body: 'Runtime?', options: [{ label: 'Node' }, { label: 'Bun' }] },
    { kind: 'ask', ts: 2, askId: 'new', title: 'Needs your decision — Checks', body: 'Checks?', multiSelect: true, options: [{ label: 'Unit' }, { label: 'Browser' }] },
  ];
  const questions = extractPendingOptionQuestions(events);
  assert.equal(questions.length, 2, 'all questions in the newest prompt render together');
  assert.equal(questions[0].header, 'Runtime');
  assert.equal(questions[1].multiSelect, true, 'multi-select intent survives transcript parsing');
  assert.deepEqual(questions[1].options.map((option) => option.label), ['Unit', 'Browser']);

  const selections = new Map([[0, new Set([1])], [1, new Set([0, 1])]]);
  assert.deepEqual(answersPayload(questions, selections), [
    { question: 'Runtime?', values: [{ key: '', label: 'Bun' }] },
    { question: 'Checks?', values: [{ key: '', label: 'Unit' }, { key: '', label: 'Browser' }] },
  ]);
}

// Wiring contract: selections are delivered question-by-question, and lifecycle/read state changes
// only once after the complete prompt. Desktop and phone both expose the fast-choice path.
{
  const sessions = read('src/sessions.js');
  const deliver = sessions.slice(sessions.indexOf('export async function deliverReply'), sessions.indexOf("route('POST', '/api/session/:id/input'"));
  assert.match(deliver, /for \(const part of sends\) await sendText/, 'multi-question answers advance the TUI in question order');
  assert.ok(deliver.indexOf('for (const part of sends)') < deliver.indexOf('noteReply(sid)'), 'Needs you clears only after every selected answer is delivered');
  assert.match(sessions, /\/api\/session\/:id\/answers/, 'structured answers endpoint exists');

  for (const file of ['web/views/dashboard.js', 'web/desktop.js']) {
    const ui = read(file);
    assert.match(ui, /data-dk-choice/, `${file}: option buttons render in Needs you`);
    assert.match(ui, /choicesComplete\(questions, selections\).*submitChoices/s, `${file}: the last required choice submits the complete prompt`);
    assert.match(ui, /status: 'working'.*unread: 0/, `${file}: successful completion removes the card`);
  }
  const phone = read('web/phone.js');
  assert.match(phone, /data-need-choice/, 'phone Needs you cards render structured options');
  assert.match(phone, /api\/session\/\$\{session\.id\}\/answers/, 'phone submits all selected answers together');
  assert.doesNotMatch(phone.slice(phone.indexOf('function patchSession'), phone.indexOf('try {', phone.indexOf('function patchSession'))), /\.sort\(/,
    'phone activity patches keep the visible session order stable');
}

console.log('attention_options.test ok');
