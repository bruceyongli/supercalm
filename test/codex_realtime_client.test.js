import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { CodexAppServerClient, publicRealtimeError } from '../src/codex_realtime_client.js';

class FakeCodex extends EventEmitter {
  constructor(onRequest) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    let buffered = '';
    this.stdin = new Writable({
      write: (chunk, encoding, done) => {
        buffered += String(chunk);
        while (buffered.includes('\n')) {
          const newline = buffered.indexOf('\n');
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line) onRequest(JSON.parse(line), this);
        }
        done();
      },
    });
  }

  reply(message) {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify(message)}\n`));
  }

  kill(signal) {
    this.exitCode = 0;
    this.emit('exit', 0, signal);
  }
}

const received = [];
let child;
const client = new CodexAppServerClient({
  codexBin: '/mock/codex',
  requestTimeoutMs: 1000,
  spawnImpl(bin, args, options) {
    assert.equal(bin, '/mock/codex');
    assert.deepEqual(args, ['app-server', '--enable', 'realtime_conversation', '--listen', 'stdio://']);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    child = new FakeCodex((message, proc) => {
      received.push(message);
      assert.equal('jsonrpc' in message, false, 'Codex JSONL omits the JSON-RPC header');
      if (message.method === 'initialize') proc.reply({ id: message.id, result: { userAgent: 'mock' } });
      if (message.method === 'account/read') proc.reply({ id: message.id, result: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } });
      if (message.method === 'thread/realtime/listVoices') {
        proc.reply({
          id: message.id,
          result: { voices: { v1: ['cove'], v2: ['marin'], defaultV1: 'cove', defaultV2: 'marin' } },
        });
      }
    });
    return child;
  },
});

await client.initialize();
assert.equal(received[0].method, 'initialize');
assert.equal(received[0].params.capabilities.experimentalApi, true, 'experimental API explicitly opted into');
assert.equal(received[1].method, 'initialized', 'initialized notification follows initialize without waiting');
assert.equal('id' in received[1], false, 'initialized is a notification');

assert.equal((await client.account()).account.type, 'apiKey');
assert.deepEqual(await client.voices(), { v1: ['cove'], v2: ['marin'], defaultV1: 'cove', defaultV2: 'marin' });

const notification = client.waitFor('thread/realtime/sdp', {
  predicate: (params) => params.threadId === 'thread-1',
});
child.reply({ method: 'thread/realtime/sdp', params: { threadId: 'thread-1', sdp: 'v=0\r\nanswer' } });
assert.equal((await notification).sdp, 'v=0\r\nanswer');

const serverError = client.waitFor('server/error');
child.reply({ method: 'error', params: { error: { message: 'turn failed' }, willRetry: false } });
assert.equal((await serverError).error.message, 'turn failed', 'App Server error notification is observable without crashing EventEmitter');

client.close();
assert.equal(child.exitCode, 0);

assert.deepEqual(publicRealtimeError(new Error('realtime conversation requires API key auth')), {
  status: 424,
  code: 'api-key-required',
  message: 'Codex realtime requires API-key authentication. Add OPENAI_API_KEY to the existing gitignored data/aios.env and restart AIOS.',
});
assert.deepEqual(publicRealtimeError(new Error('upstream detail with host context')), {
  status: 502,
  code: 'codex-realtime-failed',
  message: 'Codex realtime could not start.',
}, 'unexpected upstream details are not returned to the browser');

console.log('codex_realtime_client.test ok');
