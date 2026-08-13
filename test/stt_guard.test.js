// STT guard — locks the 2026-08-12 fix for "voice mode still generates some nonsense … what the
// heck kind of language. It's not actually read the context and use the context to record the task":
// Whisper language=auto stock hallucinations ("Продолжение следует…", "Thanks for watching", bare
// "you") were recorded verbatim as tasks/replies/titles, and dictation ignored session context.
// The guard rejects stock phrases + transcripts whose script no allowed language can produce, and
// sttContextPrompt grounds Whisper in the real session/project. Route + clients are pinned below.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guardTranscript, isStockHallucination, violatesLanguages, normalizeLangs, sttContextPrompt } from '../src/stt_guard.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// ---- stock hallucinations (the screenshot case first) ----
assert.equal(guardTranscript('Продолжение следует...', { langs: ['en'] }).rejected, 'hallucination');
assert.equal(guardTranscript('Продолжение следует...', { langs: ['en', 'ru'] }).rejected, 'hallucination',
  'a stock phrase is a hallucination even when its language is allowed');
assert.equal(guardTranscript('Продолжение следует... Продолжение следует...', { langs: [] }).rejected, 'hallucination',
  'Whisper loops the phrase — repeats are still the same hallucination');
assert.equal(guardTranscript('Thanks for watching!', { langs: ['en'] }).rejected, 'hallucination');
assert.equal(guardTranscript('you', { langs: ['en'] }).rejected, 'hallucination', "bare 'you' is Whisper's classic silence output");
assert.equal(guardTranscript('谢谢观看', { langs: ['en', 'zh'] }).rejected, 'hallucination');
assert.equal(guardTranscript('ご視聴ありがとうございました', { langs: ['ja'] }).rejected, 'hallucination');
// …but real sentences that merely CONTAIN a stock phrase pass.
assert.equal(guardTranscript('thanks for watching the deploy logs roll by, now fix the flake', { langs: ['en'] }).ok, true);
assert.equal(guardTranscript('tell the agent thank you and continue', { langs: ['en'] }).ok, true);

// ---- wrong-language rejection (script vs allowed langs) ----
assert.equal(guardTranscript('Привет, как дела с деплоем сегодня', { langs: ['en'] }).rejected, 'language');
assert.equal(guardTranscript('Привет, как дела с деплоем сегодня', { langs: ['en', 'ru'] }).ok, true);
assert.equal(guardTranscript('把会话面板改成三栏布局', { langs: ['en'] }).rejected, 'language');
assert.equal(guardTranscript('把会话面板改成三栏布局', { langs: ['en', 'zh'] }).ok, true);
assert.equal(guardTranscript('fix the CSS in session.js and redeploy', { langs: ['en'] }).ok, true);
assert.equal(guardTranscript('short ok', { langs: ['en'] }).ok, true, 'tiny transcripts never trip the script check');
assert.equal(violatesLanguages('mostly English with 一点点中文 sprinkled in the middle of it', ['en']), false,
  'a minority of foreign script does not reject a real mixed sentence');
assert.equal(guardTranscript('', { langs: ['en'] }).ok, true, 'empty stays empty-ok (no rejected marker)');

// ---- langs normalization + fail-open ----
assert.deepEqual(normalizeLangs('en-US, zh-CN, en'), ['en', 'zh']);
assert.deepEqual(normalizeLangs(''), []);
assert.equal(guardTranscript('Привет, как дела с деплоем сегодня', { langs: [] }).ok, true,
  'no langs → no script rejection (fail-open for bare API callers); stock phrases still rejected');

// ---- context prompt ("read the context and use the context") ----
const prompt = sttContextPrompt({ project: { name: 'supercalm' }, session: { tool: 'codex', title: 'fix the voice STT nonsense' }, extra: 'queue reply' });
assert.ok(prompt.includes('supercalm') && prompt.includes('codex') && prompt.includes('fix the voice STT nonsense'), 'prompt carries project/tool/task');
assert.ok(sttContextPrompt({ session: { title: 'x'.repeat(2000) } }).length <= 600, 'prompt is hard-capped');

// ---- route + client pins: every transcribe surface goes through the guard/grounding ----
const spark = read('src/spark.js');
assert.match(spark, /guardTranscript\(out\.text, \{ langs \}\)/, '/api/transcribe guards every backend output');
assert.match(spark, /sttContextPrompt\(\{ session, project/, 'the route builds the Whisper prompt from real rows');
assert.match(spark, /language === 'auto' && langs\.length === 1/, 'a single allowed language hard-pins Whisper instead of auto');
const common = read('web/common.js');
assert.match(common, /preferredSttLangs/, 'clients send their allowed dictation languages');
assert.match(common, /if \(!j\.rejected\) rememberSpeechLanguage/, 'a rejected take cannot poison the recognizer language preference');
assert.match(read('web/voicemode.js'), /&langs=/, 'voice assistant dictation is language-guarded');
assert.match(read('web/phone.js'), /&langs=/, 'phone dictation is language-guarded');

console.log('stt_guard.test ok');
