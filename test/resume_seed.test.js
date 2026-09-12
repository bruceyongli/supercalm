import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { originalTaskSeed } from '../src/resume_seed.js';

const task = { direction: 'in', source: 'task', text: 'Build the complete friends project from this long prompt.' };
assert.equal(originalTaskSeed([task]), task.text,
  'an unstarted session with no native conversation is reseeded from its durable task');
assert.equal(originalTaskSeed([task], { hasNativeConversation: true }), null,
  'an existing native conversation always keeps provider continuation semantics');
assert.equal(originalTaskSeed([task, { direction: 'in', source: 'text', text: 'One more requirement.' }]), null,
  'a session with later operator input is never collapsed back to its launch prompt');
assert.equal(originalTaskSeed([{ ...task, source: 'text' }]), null,
  'only the original launch-task record is eligible for automatic reseeding');
assert.equal(originalTaskSeed([{ ...task, text: '   ' }]), null, 'an empty task is not launchable');

const sessions = readFileSync(new URL('../src/sessions.js', import.meta.url), 'utf8');
const resumeBlock = sessions.slice(sessions.indexOf('async function resumeNow'), sessions.indexOf('// ---------------------------------------------------------------------------\n// status poll loop'));
assert.match(resumeBlock, /findClaudeLog[\s\S]*originalTaskSeed/, 'Claude resume proves the native conversation is absent before reseeding');
assert.match(resumeBlock, /task:\s*resumeTask[\s\S]*resume:\s*continueConversation/, 'the durable task replaces --continue for an unstarted session');
assert.match(resumeBlock, /resumeTask[\s\S]*durableStatus = 'working'/, 'reseeded work clears a stale waiting lifecycle');

console.log('resume_seed: all assertions passed');
