import assert from 'node:assert/strict';
import { voiceSpeakerControl } from '../web/voice-controls.js';
for (const text of ['okay can you change to your female voice instead of male voice', 'Use a female voice.',
  'Could you switch your voice to Vivian?', 'Please speak in a female voice', '换成女声', '可以用女声吗', '好的，切换到Vivian']) {
  assert.equal(voiceSpeakerControl(text)?.voice, 'Vivian', text);
}
for (const text of ['Use Ryan', 'Switch to your male voice', 'Please change your voice to Ryan', '换成男声', '请用男声']) {
  assert.equal(voiceSpeakerControl(text)?.voice, 'Ryan', text);
}
for (const text of ['Fix the female voice in the app', 'Change to a female voice and deploy the project',
  'Can you explain the female voice bug?', 'This project uses a female voice', 'Yes, send it', 'next', '']) {
  assert.equal(voiceSpeakerControl(text), null, 'mixed/project speech is not an assistant-only control: ' + text);
}
console.log('voice_controls.test ok');
