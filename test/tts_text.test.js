import assert from 'node:assert/strict';
import { splitSentences, textForTts, speechTextRange } from '../web/tts-player.js';

assert.equal(
  textForTts('Release v0.3.286 on 2026.07.22 with value 3.14.'),
  'Release v0 point 3 point 286 on 2026 point 07 point 22 with value 3 point 14.',
  'numeric dots become one continuous spoken phrase before any TTS engine sees them',
);
assert.deepEqual(
  splitSentences('Release 2026.07.22 is ready. Open file.js next. Version v0.3.286 stays intact.'),
  ['Release 2026.07.22 is ready.', 'Open file.js next.', 'Version v0.3.286 stays intact.'],
  'dotted dates, filenames, and versions are never mistaken for sentence boundaries',
);
assert.deepEqual(splitSentences('First sentence. Second sentence? Third sentence!'), [
  'First sentence. Second sentence?', 'Third sentence!',
], 'short neighboring sentences may share one natural playback chunk');
const source = 'Release v0.3.331 is ready. PIXY. Gimbal is the verified camera. 中文输入也可以使用。';
const first = speechTextRange(source, 'Release v0 point 3 point 331 is ready.');
assert.equal(source.slice(first.start, first.end), 'Release v0.3.331 is ready.');
const next = speechTextRange(source, 'PIXY. Gimbal is the verified camera.', first.end);
assert.equal(source.slice(next.start, next.end), 'PIXY. Gimbal is the verified camera.', 'model phrases can cross punctuation without forced line breaks');
assert.equal(speechTextRange(source, 'unknown phrase'), null);
assert.equal(speechTextRange(source, 'Release', source.length), null, 'reading cannot loop to the beginning');

console.log('tts_text.test ok');
