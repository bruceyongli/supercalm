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

const chineseReport = 'AIOS 的语音输入已经更新，现在支持中文和 English。请检查手机上的录音功能。';
for (const text of ['停一下', '暂停', '为什么', '怎么解决的', '请解释一下', '不是，我问的是中文输入', '我需要修改手机界面']) {
  assert.equal(isClearVoiceInterruption(text, chineseReport), true, `${text} can interrupt a Chinese report`);
}
assert.equal(isClearVoiceInterruption('语音输入已经更新现在支持中文和 English', chineseReport), false,
  'Chinese speaker echo is rejected even with different punctuation');
assert.equal(isClearVoiceInterruption('我们去旁边的咖啡店聊天', chineseReport), false, 'nearby Chinese chatter does not seize the turn');
const interrupted = 'AIOS 的语音输入已经更新现在支持中文和 English，等一下，为什么以前不支持中文？';
assert.equal(isClearVoiceInterruption(interrupted, chineseReport), true);
assert.equal(extractVoiceInterruption(interrupted, chineseReport), '等一下，为什么以前不支持中文？');

console.log('voice_interruption.test ok');
