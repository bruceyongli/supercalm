import assert from 'node:assert/strict';
import { attachmentName, storageName } from '../src/upload_names.js';
import { transferredFiles, previewDescriptor } from '../web/composer-files.js';
import { extractAttachments, extractAttachmentImages } from '../src/story.js';

const original = '第  2 版 [复核] 🌱.png';
assert.equal(attachmentName('C:\\folder\\' + original), original);
assert.equal(attachmentName('../a\nb\u202ec.jpg'), 'abc.jpg');
assert.equal(attachmentName('..'), 'attachment');
const prefix = '1790111111111-u_0123456789-';
const long = '复核🌱'.repeat(80) + '.jpeg', key = storageName(prefix, long);
assert.ok(Buffer.byteLength(key) <= 255 && key.endsWith('.jpeg') && key.startsWith(prefix));
assert.equal(attachmentName(long), long);
const file = (name, text = 'test', type = '') => new File([text], name, {type});
const item = (f, entry = null) => ({kind:'file', getAsFile:() => f, webkitGetAsEntry:() => entry});
const drop = (files, items, strings = {}) => ({files, items, getData:key => strings[key] || ''});
const img = file(original, 'bytes', 'image/png'), generic = file('image.png', 'bytes', 'image/png');
const second = file(original, 'other', 'image/png');
assert.equal((await transferredFiles(drop([generic], [item(img)])))[0].name, original);
assert.deepEqual((await transferredFiles(drop([img, second], [item(generic), item(second)]))).map(f => f.name), [original,original]);
assert.deepEqual(await Promise.all((await transferredFiles(drop([img, second], [item(img)]))).map(f => f.text())), ['bytes','other']);
assert.deepEqual(await Promise.all((await transferredFiles(drop([img, second], [item(second)]))).map(f => f.text())), ['bytes','other']);
assert.deepEqual((await transferredFiles(drop([], [item(null, {isFile:true, name:original, file:cb => cb(generic)})]))).map(f => f.name), [original]);
assert.equal((await transferredFiles(drop([], [item(generic)], {'text/uri-list':'file:///private/' + encodeURIComponent(original)})))[0].name, original);
assert.equal((await transferredFiles(drop([], [item(generic)], {DownloadURL:'image/png:' + original + ':https://example.invalid/image'})))[0].name, original);
assert.equal((await transferredFiles(drop([img], [], {'text/uri-list':'file:///other.png'})))[0].name, original);
assert.equal((await transferredFiles(drop([generic], [], {'text/uri-list':'file:///other.pdf'})))[0].name, 'image.png');
assert.deepEqual(await transferredFiles(drop([], [item(null,{isDirectory:true})])), []);
const header = Uint8Array.of(137,80,78,71,13,10,26,10);
for (const [f, kind, name] of [
  [file('', header, 'application/octet-stream'),'image','Image.png'],
  [file('', 'a,b\n','text/csv'),'text','Text.csv'],
  [file('录音.wav'),'audio','录音.wav'], [file('短片.mov'),'video','短片.mov'],
  [file('说明.pdf','%PDF-1.7\n'),'pdf','说明.pdf'],
  [file('README','说明\n'),'text','README'], [file('空.txt',''),'text','空.txt'],
  [file('网页.html','<h1>hi</h1>','text/html'),'text','网页.html'],
  [file('not-a-pdf.pdf','<html></html>'),'file','not-a-pdf.pdf'],
  [file('', Uint8Array.of(0,255)),'file','Attachment'],
]) {
  const p = await previewDescriptor(f);
  assert.equal(p.kind, kind); assert.equal(p.name, name); assert.equal(p.blob.size, f.size);
  if (kind === 'text') assert.equal(p.blob.type, 'text/plain');
}
const shot = '对照 [旧].png 与新.png', path = '/fixture/.aios/attachments/s_test/' + prefix + shot;
const manifest = '1. ' + shot + ' (PNG, image/png): ' + path;
assert.deepEqual(extractAttachments(manifest), [{name:shot,path}]);
assert.deepEqual(extractAttachmentImages(manifest), [prefix + shot]);
assert.deepEqual(extractAttachmentImages('[Image: source: ' + path + ']'), [prefix + shot]);
console.log('Composer files: original names, disk limits, promised/partial drops, distinct duplicates, content previews and Story keys passed.');
