import assert from 'node:assert/strict';
import { cleanSessionTitle, fallbackSessionTitle, titleContext } from '../src/session_title.js';

assert.equal(cleanSessionTitle('  Fix   the   graph\npanel  '), 'Fix the graph panel');
assert.equal(cleanSessionTitle('x'.repeat(120)).length, 90);
assert.equal(cleanSessionTitle('\0\ntitle\twith\rcontrols'), 'title with controls');

const messages = [
  { direction: 'in', text: 'okay' },
  { direction: 'out', text: 'Agent asks for clarification' },
  { direction: 'in', text: 'Make session titles customizable or summarize them with a cheap model.' },
];
const title = fallbackSessionTitle({ session: { title: 'old' }, messages, events: [] });
assert.equal(title, 'Make session titles customizable or summarize them with a cheap model.');

const eventTitle = fallbackSessionTitle({
  session: { title: 'old' },
  messages: [],
  events: [
    { ts: 1, payload: JSON.stringify({ task: 'Old setup task' }) },
    { ts: 2, payload: JSON.stringify({ task: 'Current title controls' }) },
  ],
});
assert.equal(eventTitle, 'Current title controls');

const ctx = titleContext({ session: { tool: 'codex', title: 'old' }, project: { name: 'aios' }, messages, events: [] });
assert(ctx.includes('project: aios'));
assert(ctx.includes('tool: codex'));
assert(ctx.includes('operator: Make session titles customizable'));

console.log('session_title.test ok');
