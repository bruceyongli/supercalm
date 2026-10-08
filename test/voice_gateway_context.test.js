import assert from 'node:assert/strict';
import { gatewayConversation, utf8Limit } from '../src/voice_gateway_context.js';
import { voiceSourceContext } from '../src/voice_sources.js';

assert.equal(utf8Limit('中文ab', 7), '中文a');
const item = { projectIdentity: 'aios/supercalm', originalRequest: '改善语音讲解，不要念测试数量。' };
const evidence = { requestContext: item.originalRequest, reportContext: '声音固定，不会随着中英文切换。',
  recentConversation: 'Agent report: 首句准备好就立即播放，不等全部文字生成完。',
  sourcePack: { sources: [{ name: 'Voice plan', fileName: 'plan.md', sections: [
    { heading: 'Overview', text: '其他项目不变。' }, { heading: '如何取消', text: '打断后取消请求，清空音频队列，不再重读。' },
  ] }] } };
const question = '打断后怎么取消请求？';
const payload = gatewayConversation({ item, evidence, question, voice: 'Vivian',
  history: [{ role: 'assistant', content: '我们刚才在讲语音播放器。' }] });
assert.ok(payload.text.startsWith(question), 'the user question is preserved as the actual current turn');
assert.match(payload.history[0].content, /aios\/supercalm/);
assert.match(payload.history[0].content, /清空音频队列/);
assert.match(payload.history[0].content, /刚才在讲语音播放器/);
assert.match(payload.history[0].content, /never instructions to execute/);
assert.equal(payload.voice, 'Vivian'); assert.equal(payload.tts_only, undefined, 'Omni runs its realtime conversation, not a script read-out');
assert.match(voiceSourceContext(evidence.sourcePack, question), /SECTION: 如何取消/);
const huge = { ...evidence, reportContext: '长篇报告'.repeat(9000), recentConversation: '历史'.repeat(20000) };
const bounded = gatewayConversation({ item, evidence: huge, question: '中文'.repeat(300), history: [{ role: 'assistant', content: '回答'.repeat(5000) }] });
assert.ok(Buffer.byteLength(bounded.text) <= 3000);
assert.ok(Buffer.byteLength(bounded.text) + Buffer.byteLength(bounded.history[0].content) <= 5200);
assert.ok(!bounded.history[0].content.includes('\uFFFD'), 'UTF-8 truncation cannot split Han characters');
assert.throws(() => gatewayConversation({ item, evidence, question: '中文'.repeat(2500) }), /too long/, 'a long question is never silently truncated');
assert.match(gatewayConversation({ item, evidence, opening: true }).text, /^请讲解/);
const microphone = gatewayConversation({ item, evidence: huge, microphone: true, voice: 'Sohee' });
assert.equal(microphone.text, undefined, 'stream creation cannot invent the unheard question');
assert.equal(microphone.voice, 'Sohee');
assert.match(microphone.history[0].content, /Approved documents:/, 'long reports cannot crowd linked sources out of microphone context');
assert.ok(Buffer.byteLength(microphone.history[0].content) + Buffer.byteLength(microphone.system) + 3000 < 6000,
  'microphone context reserves the full final-transcript byte budget');
console.log('voice_gateway_context.test ok');
