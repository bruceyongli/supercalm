import assert from 'node:assert/strict';
import { VOICE_CAPTURE_DEFAULTS, voiceTranscriptDisposition } from '../web/voice-input.js';

assert.deepEqual(VOICE_CAPTURE_DEFAULTS, { threshold: 0.045, silenceMs: 1800, graceMs: 8000, minSpeechMs: 500 });

for (const fragment of ['I', 'a', 'is', '.', '  ']) {
  assert.equal(voiceTranscriptDisposition(fragment).accepted, false, `${JSON.stringify(fragment)} is not a conversational turn`);
}
for (const intent of ['yes', 'No', 'okay', 'stop', 'next', 'why', '继续']) {
  assert.equal(voiceTranscriptDisposition(intent).accepted, true, `${intent} remains a valid short reply`);
}
assert.equal(voiceTranscriptDisposition('the flashing issue').accepted, true);
assert.deepEqual(
  voiceTranscriptDisposition('the current report', { spoken: 'Here is the current report for AIOS.' }),
  { accepted: false, reason: 'playback-echo', text: '' },
  'the tail of iPhone speaker playback cannot become operator speech',
);
assert.equal(voiceTranscriptDisposition('Can you explain the actual cause?', {
  spoken: 'The update is ready for review.',
}).accepted, true);

console.log('voice_input.test ok');
