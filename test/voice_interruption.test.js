import assert from 'node:assert/strict';
import { extractVoiceInterruption, isClearVoiceInterruption, isPlaybackEcho } from '../web/voice-interruption.js';

const report = 'AIOS Supercalm. Voice Assistant. Report quality. What changed is the update now explains the actual fix.';

assert.equal(isPlaybackEcho('Voice Assistant report quality', report), true);
assert.equal(isClearVoiceInterruption('What changed is the update now explains the actual fix', report), false,
  'the assistant cannot interrupt itself when recognition hears its speaker');
assert.equal(isClearVoiceInterruption('Stop', report), true, 'a direct stop is accepted immediately');
assert.equal(isClearVoiceInterruption('Wait, what actually caused the problem?', report), true, 'a direct question can barge in');
assert.equal(isClearVoiceInterruption('Actually, that is not what I asked for', report), true, 'a correction can barge in');
assert.equal(isClearVoiceInterruption('okay', report), false, 'a short backchannel does not cut off the assistant');
assert.equal(isClearVoiceInterruption('AIOS Supercalm voice assistant wait tell me the cause', report), true,
  'a clear operator cue appended after captured speaker echo is still accepted');
assert.equal(extractVoiceInterruption('AIOS Supercalm voice assistant wait tell me the cause', report), 'wait tell me the cause',
  'captured speaker words are removed before the interruption enters conversation history');
assert.equal(isClearVoiceInterruption('People are talking beside the road today', report), false,
  'unaddressed ambient conversation does not seize the turn');
assert.equal(isClearVoiceInterruption('', report), false);

console.log('voice_interruption.test ok');
