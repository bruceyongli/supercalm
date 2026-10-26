import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { requestStory, interruptedStoryRequest } from '../web/story-request.js';

const body = JSON.stringify({ sessionId: 's_own', events: [{ kind: 'report', body: '项目更新：已解决。'.repeat(20) }], meta: {} });
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/headers') return; // no response at all
  if (req.url === '/progress') {
    res.flushHeaders();
    const bytes = Buffer.from(body); let offset = 0;
    // Split UTF-8 characters as well as JSON tokens, as a real mobile transport does.
    const timer = setInterval(() => {
      res.write(bytes.subarray(offset, offset + 71)); offset += 71;
      if (offset >= bytes.length) { clearInterval(timer); res.end(); }
    }, 20);
    res.on('close', () => clearInterval(timer)); return;
  }
  if (req.url === '/stalled') { res.flushHeaders(); res.write('{"events":['); return; }
  if (req.url === '/truncated') return res.end('{"events":[');
  if (req.url === '/invalid') return res.end('{}');
  if (req.url === '/missing') { res.statusCode = 404; return res.end('{"error":"no such session"}'); }
  if (req.url === '/cursor') { res.statusCode = 409; return res.end('{"error":"History changed","code":"STORY_CURSOR_INVALID"}'); }
  return res.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const options = { headerTimeoutMs: 100, idleTimeoutMs: 100, maxDurationMs: 2000 };
try {
  const start = Date.now();
  assert.deepEqual(await requestStory(base + '/progress', options), JSON.parse(body));
  assert.ok(Date.now() - start > options.idleTimeoutMs, 'progress extends the idle deadline, rather than a total fetch cutoff');
  for (const path of ['/headers', '/stalled']) {
    await assert.rejects(requestStory(base + path, options), e => e.code === 'STORY_TIMEOUT' && interruptedStoryRequest(e));
  }
  await assert.rejects(requestStory(base + '/progress', { ...options, maxDurationMs: 80 }), e => e.code === 'STORY_TIMEOUT', 'continuous data still has an absolute bound');
  for (const path of ['/truncated', '/invalid']) {
    await assert.rejects(requestStory(base + path, options), e => e.code === 'STORY_INCOMPLETE' && interruptedStoryRequest(e), 'bad bodies never masquerade as an empty successful Story');
  }
  await assert.rejects(requestStory(base + '/missing', options), e => e.status === 404 && !interruptedStoryRequest(e));
  await assert.rejects(requestStory(base + '/cursor', options), e => e.code === 'STORY_CURSOR_INVALID');
  assert.equal((await requestStory(base, { ...options, sessionId: 's_own' })).sessionId, 's_own');
  await assert.rejects(requestStory(base, { ...options, sessionId: 's_other' }),
    e => e.code === 'STORY_SESSION_MISMATCH' && interruptedStoryRequest(e), 'a response owned by another session never reaches the feed');
  const controller = new AbortController();
  const pending = requestStory(base + '/stalled', { ...options, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, e => e.name === 'AbortError' && e.code !== 'STORY_TIMEOUT', 'navigation cancellation is not mislabeled a timeout');
  await assert.rejects(requestStory(base, { ...options, signal: AbortSignal.abort() }), e => e.name === 'AbortError');
  assert.equal(interruptedStoryRequest(new DOMException('Fetch is aborted.', 'AbortError')), true, 'WebKit cancellation text is not shown as a permanent error');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
console.log('story_request: progressive UTF-8, idle/header deadlines, cancellation, invalid bodies and HTTP errors passed');
