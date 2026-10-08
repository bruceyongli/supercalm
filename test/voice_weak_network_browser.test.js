import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createVoiceStreamJob } from '../src/voice_stream_job.js';
import { wavFromPcm, NATIVE_TTS_MODEL } from '../src/tts_native.js';
import { createVoiceDialogueState, resolveVoiceTurn } from '../src/voice_turn.js';

// Production PCM player + resumable/gzip journal under mobile bandwidth, a dropped connection,
// and temporary offline status. The only generated audio/model answers are private CPU fixtures.
const web = fileURLToPath(new URL('../web/', import.meta.url));
const jobs = new Map(), readers = new Set(), requests = [], timers = [];
let generations = 0, progressReads = 0, cancelCalls = 0, partialGenerations = 0;
const reviewTurns = []; let reviewContinues = 0, receiptErrors = 0;
const first = 'The connection can recover without repeating the report. ';
const second = 'Your feedback stays with this project.';
const pcm = Buffer.alloc(48000);
for (let i = 0; i < 24000; i++) pcm.writeInt16LE(Math.round(12000 * Math.sin(i * Math.PI * 2 * (210 + i / 1500) / 24000)), i * 2);
const frame = index => ({ index, audio: wavFromPcm(pcm).toString('base64'), model: NATIVE_TTS_MODEL,
  engine: 'qwen', precision: 'BF16', backend: 'faster-ggml', voice: 'Ryan', prosody_profile: 'steady-v3',
  streaming: 'native-pcm-frames', segmentIndex: index ? 1 : 0, text: index === 0 ? first : index === 2 ? second : '' });
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/aios/harness') {
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<base href="/aios/"><link rel="stylesheet" href="styles.css"><button id="play">Play</button><button id="assistant">Assistant</button><button id="review">Review</button>
      <script type="module">const p=await import('./tts-player.js');
      const v=await import('./voicemode.js');window.__ready=true;document.querySelector('#assistant').onclick=()=>{window.__assistant=v.startVoiceMode({focusSessionId:'private'});};
      document.querySelector('#review').onclick=()=>{window.__review=v.startVoiceMode({source:'fixture-review-later'});};
      document.querySelector('#play').onclick=()=>{p.unlockAudio();window.__phrases=[];window.__text='';window.__reconnects=0;window.__partial=0;
      window.__h=p.newPlayback();window.__run=p.speakConversation(window.__h,{voiceId:'private',voice:'Ryan',opening:true,
      onText:delta=>window.__text+=delta,onSegment:p=>window.__phrases.push(p.text),onPartial:()=>window.__partial++,
      onReconnecting:()=>window.__reconnects++}).then(result=>window.__result=result);};</script>`); return;
  }
  if (url.pathname === '/aios/api/tts/stream') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const b = JSON.parse(raw); res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: metadata\ndata: {"transport":"native-pcm-frames"}\n\n');
    if (b.text.startsWith('好，收到')) { receiptErrors++; res.end('event: error\ndata: {"detail":"Fixture receipt audio unavailable"}\n\n'); }
    else res.end(`event: audio\ndata: ${JSON.stringify({ ...frame(0), text: b.text })}\n\nevent: done\ndata: ${JSON.stringify({ text: b.text })}\n\n`);
    return;
  }
  if (url.pathname.startsWith('/aios/api/voice/')) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const b = JSON.parse(raw || '{}');
    const reply = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname.endsWith('/start') && b.source === 'fixture-review-later') return reply({ voiceId: 'review', say: 'First review report is ready.', listen: true,
      current: { sessionId: 'review_first', project: 'First review project', reportId: 2, n: 1, total: 2 } });
    if (url.pathname.endsWith('/turn') && b.voiceId === 'review') {
      reviewTurns.push(b);
      const resolved = await resolveVoiceTurn({ dialogue: createVoiceDialogueState(), sessionId: 'review_first', userText: b.userText,
        brain: async () => { throw new Error('Review-later replies must not need a model'); } });
      assert.equal(resolved.reply.control, 'review-later');
      return reply({ say: resolved.reply.say, listen: false, done: false,
        delivery: { status: 'skipped', reason: 'operator-review-later' },
        current: { sessionId: 'review_first', project: 'First review project', reportId: 2, n: 1, total: 2 } });
    }
    if (url.pathname.endsWith('/continue') && b.voiceId === 'review') {
      reviewContinues++;
      return reply({ say: '', listen: true, done: false, current: { sessionId: 'review_second', project: 'Second review project', reportId: 3, n: 2, total: 2 } });
    }
    if (url.pathname.endsWith('/start')) return reply({ voiceId: 'partial', say: '', realtimeOpening: true, listen: true,
      current: { sessionId: 'private', project: 'Weak network fixture', reportId: 1, n: 1, total: 1 } });
    if (/\/(dismiss|continue|stop|keepalive)$/.test(url.pathname)) return reply({ ok: true, say: '', done: true });
    if (url.pathname.endsWith('/progress')) {
      progressReads++; const job = jobs.get(b.requestId);
      return reply({ text: job?.text || '', complete: !!job?.closed, stage: job?.stage });
    }
    if (url.pathname.endsWith('/cancel')) { cancelCalls++; jobs.get(b.requestId)?.cancel(); return reply({ ok: true }); }
    assert.ok(url.pathname.endsWith('/converse'), 'this test must never send coding-agent feedback');
    requests.push(b);
    let job = jobs.get(b.requestId);
    if (!job) {
      assert.equal(b.resume, undefined, 'resume cannot create another generation');
      if (b.voiceId === 'partial') partialGenerations++; else generations++;
      job = createVoiceStreamJob({ requestId: b.requestId, controller: new AbortController(), orphanMs: 4000 });
      jobs.set(b.requestId, job);
      job.append('metadata', { transport: 'native-pcm-frames', voice: 'Ryan' });
      job.append('text', { delta: first });
      if (b.voiceId === 'partial') {
        job.append('audio', frame(0));
        timers.push(setTimeout(() => job.append('error', { detail: 'Fixture upstream stopped after speech began' }), 1800));
      } else {
        timers.push(setTimeout(() => { job.append('audio', frame(0)); job.append('audio', frame(1)); }, 100));
        timers.push(setTimeout(() => {
          job.append('text', { delta: second }); job.append('audio', frame(2)); job.append('audio', frame(3));
        }, 350));
      }
    }
    readers.add(res); res.on('close', () => readers.delete(res));
    job.attach(res, { after: b.afterEvent || 0, compressed: /\bgzip\b/.test(req.headers['accept-encoding'] || '') });
    if (b.resume) job.append('done', { text: first + second });
    return;
  }
  const path = resolve(web, url.pathname.replace(/^\/aios\//, ''));
  if (!path.startsWith(web)) { res.writeHead(403); res.end(); return; }
  try { res.writeHead(200, { 'content-type': ['.js', '.mjs'].includes(extname(path)) ? 'text/javascript' : extname(path) === '.css' ? 'text/css' : 'text/plain' }); res.end(readFileSync(path)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    const timeout = window.setTimeout.bind(window);
    // Accelerate ONLY the former 90-second cap. This transfer lasts longer than 5 seconds but
    // keeps producing valid events, so a fixed whole-response cap would reproduce the screenshot.
    window.setTimeout = (callback, ms, ...args) => timeout(callback, ms === 90000 ? 5000 : ms, ...args);
  });
  page.on('pageerror', error => console.error('weak-network browser error:', error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/aios/harness`);
  await page.waitForFunction(() => window.__ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  const slow = { offline: false, latency: 80, downloadThroughput: 24000, uploadThroughput: 12000 };
  await cdp.send('Network.emulateNetworkConditions', slow);
  const t0 = Date.now(); await page.locator('#play').click();
  // The separate tiny progress response carries all text before the bulky audio is downloaded.
  await page.waitForFunction(text => window.__text === text, first + second);
  assert.ok(await page.evaluate(() => !window.__result), 'all text becomes readable before audio finishes');
  assert.ok(progressReads > 0, 'small text snapshots avoid audio head-of-line blocking');
  await page.waitForFunction(() => window.__phrases.length >= 1);
  await cdp.send('Network.emulateNetworkConditions', { ...slow, offline: true });
  for (const response of readers) response.destroy(); // genuine HTTP break, not a screenshot/composer assertion
  await page.waitForFunction(() => window.__reconnects > 0);
  await page.waitForTimeout(900);
  await cdp.send('Network.emulateNetworkConditions', slow);
  await page.evaluate(() => window.__run);
  const result = await page.evaluate(() => ({ answer: window.__result?.text, text: window.__text,
    phrases: window.__phrases, reconnects: window.__reconnects, partial: window.__partial }));
  assert.equal(result.answer, first + second); assert.equal(result.text, first + second);
  assert.deepEqual(result.phrases, [first, second], 'neither text nor speech restarts at the beginning');
  assert.equal(result.partial, 0); assert.equal(generations, 1);
  assert.equal(new Set(requests.map(request => request.requestId)).size, 1);
  assert.ok(requests.some(request => request.resume && request.afterEvent > 0));
  assert.equal(cancelCalls, 0, 'a brief broken download does not cancel/restart the model');
  console.log('voice_weak_network_browser trace', JSON.stringify({ pass: true, bandwidthBytesPerSec: 24000,
    generations, progressReads, requests: requests.map(({ requestId, resume, afterEvent }) => ({ requestId, resume, afterEvent })),
    reconnects: result.reconnects, phrases: result.phrases.length, elapsedMs: Date.now() - t0, partial: result.partial }));

  // A permanent upstream failure is NOT a network reconnect or a completed report. The real voice
  // loop must pause with a dismissible report, not silently start recording the caller's response.
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.evaluate(() => {
    localStorage.setItem('aios_tts', 'neural'); window.__micReads = 0;
    window.SpeechRecognition = class { start() {} abort() {} stop() {} };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => { window.__micReads++; throw new Error('Must not record after a partial report'); },
    } });
  });
  await page.locator('#assistant').click();
  await page.waitForFunction(() => document.querySelector('.vm-state')?.textContent === 'Connection paused');
  assert.equal(partialGenerations, 1, 'a terminal model error cannot be automatically regenerated');
  assert.equal(await page.evaluate(() => window.__micReads), 0, 'an unfinished report must not advance to listening');
  assert.equal(await page.locator('.vm-interrupt').textContent(), 'Ask a follow-up');
  assert.match(await page.locator('.vm-said').textContent(), /connection can recover/);
  await page.locator('.vm-dismiss').click(); await page.evaluate(() => window.__assistant);
  assert.equal(await page.locator('.vm').count(), 0, 'Dismiss remains usable after a partial report');
  console.log('voice_weak_network_browser partial trace', JSON.stringify({ pass: true, generations: partialGenerations,
    paused: true, prematureRecording: false, dismissible: true }));

  // After an accepted navigation action, even an unavailable spoken receipt cannot strand the UI
  // on the old report. Drive bilingual navigation through the real voice loop and reducer; the
  // exact screenshot reply (without an interruption cue) is covered by the actual backend test.
  await page.evaluate(() => {
    let recognized = false; window.__receipts = [];
    window.SpeechRecognition = class {
      start() { this.onstart?.(); if (!recognized) { recognized = true; setTimeout(() => this.onresult?.({ results: [
        Object.assign([{ transcript: '下一个，OK,非常棒,我待会儿会测试一下。' }], { isFinal: true })] }), 150); } }
      abort() { this.onend?.(); } stop() { this.onend?.(); }
    };
    new MutationObserver(() => {
      const receipt = document.querySelector('.ongo-delivery');
      if (receipt && !receipt.hidden) window.__receipts.push({ text: receipt.textContent, failed: receipt.classList.contains('failed') });
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  await page.locator('#review').click();
  try { await page.waitForFunction(() => document.querySelector('.ongo-title')?.textContent === 'Second review project'); }
  catch (error) {
    console.log('review navigation failure trace', JSON.stringify({ reviewTurns, reviewContinues, receiptErrors,
      ui: await page.evaluate(() => ({ title: document.querySelector('.ongo-title')?.textContent,
        state: document.querySelector('.vm-state')?.textContent, heard: document.querySelector('.vm-heard')?.textContent,
        notice: document.querySelector('.vm-tts-notice')?.textContent, receipts: window.__receipts })) }));
    throw error;
  }
  assert.equal(reviewTurns.length, 1); assert.match(reviewTurns[0].userText, /非常棒.*待会儿会测试一下/);
  assert.equal(reviewContinues, 1); assert.equal(receiptErrors, 1, 'the actual native receipt failed');
  const receipts = await page.evaluate(() => window.__receipts);
  assert.ok(receipts.some(receipt => receipt.text.includes('later review') && !receipt.failed), 'deferral is not rendered as a failed message send');
  await page.locator('.vm-stop').click(); await page.evaluate(() => window.__review);
  console.log('voice_review_navigation_browser trace', JSON.stringify({ pass: true, heard: reviewTurns[0].userText,
    nextProject: 'Second review project', continues: reviewContinues, unavailableReceiptDidNotBlock: true, misleadingFailureReceipt: false }));
} finally {
  for (const timer of timers) clearTimeout(timer);
  for (const job of jobs.values()) job.cancel();
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
