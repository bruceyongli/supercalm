import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { uploadExecutionPart } from '../src/execution_bundle.js';

// Large Git exports can spend minutes preparing before producing a first byte.
// The worker must receive/authenticate headers immediately, not wait for stdout.
let headersAt = 0, bytesAt = 0;
const server = http.createServer(async (req, res) => {
  headersAt = Date.now();
  assert.equal(req.headers['x-aios-node-token'], 'fixture-token');
  const hash = createHash('sha256'); let size = 0;
  try { for await (const chunk of req) { bytesAt ||= Date.now(); size += chunk.length; hash.update(chunk); } }
  catch (error) { if (req.aborted) return; throw error; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ size, sha256: hash.digest('hex') }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const started = Date.now();
  const pending = uploadExecutionPart({ localPort: server.address().port, token: 'fixture-token' },
    'x_' + '1'.repeat(24), 'git', {
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.stdout.write("delayed bundle"), 1500)'],
    }, { timeout: 5000 });
  // Simulate the real header deadline separately from the producer's delay.
  await new Promise(resolve => setTimeout(resolve, 400));
  const deliveredHeadersBeforeExport = headersAt > 0 && bytesAt === 0;
  const receipt = await pending;
  assert.ok(deliveredHeadersBeforeExport, 'headers must not wait for archive generation');
  assert.ok(bytesAt - started >= 1400);
  assert.equal(receipt.size, Buffer.byteLength('delayed bundle'));
  assert.equal(receipt.sha256, createHash('sha256').update('delayed bundle').digest('hex'));
  const progressing = await uploadExecutionPart({localPort:server.address().port,token:'fixture-token'},
    'x_'+'2'.repeat(24),'artifacts',{command:process.execPath,args:['-e',
      'let n=0;const t=setInterval(()=>{process.stdout.write("x");if(++n===4)clearInterval(t)},500)']},{timeout:1000});
  assert.equal(progressing.size,4,'a progressing transfer outlives a single idle deadline');
  await assert.rejects(uploadExecutionPart({localPort:server.address().port,token:'fixture-token'},
    'x_'+'3'.repeat(24),'artifacts',{command:process.execPath,args:['-e',
      'process.stdout.write("x");setTimeout(()=>process.stdout.write("late"),10000)']},{timeout:500}),/stalled/);
  console.log('Execution upload authenticates before delayed archive output; receipt matches.');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
