import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { requestInputJson } from '../web/input-request.js';
let posts = 0;
const server = createServer((req, res) => {
  if (req.method === 'POST') posts++;
  if (req.url === '/headers') return;
  if (req.url === '/body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"ok":'); return; }
  if (req.url === '/invalid') return res.end('{');
  if (req.url === '/rejected') { res.statusCode = 409; return res.end('{"inputBlocked":true}'); }
  res.end('{"ok":true}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  assert.equal((await requestInputJson(base)).json.ok, true);
  for (const path of ['/headers', '/body']) {
    await assert.rejects(requestInputJson(base + path, { method: 'POST', timeoutMs: 80 }), { code: 'INPUT_TIMEOUT' });
  }
  assert.equal(posts, 2, 'timeouts never automatically POST again');
  await assert.rejects(requestInputJson(base + '/invalid'), SyntaxError);
  const rejected = await requestInputJson(base + '/rejected');
  assert.equal(rejected.response.status, 409); assert.equal(rejected.json.inputBlocked, true);
  const controller = new AbortController();
  const request = requestInputJson(base + '/headers', { signal: controller.signal });
  controller.abort(); await assert.rejects(request, { name: 'AbortError' });
  console.log('input_request: headers/body deadlines, unknown partial response, no replay, and navigation cancellation passed');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
