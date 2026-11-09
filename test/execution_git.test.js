import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { executionGit } from '../src/execution_git.js';

function fixture(run) {
  return (_file, args, options) => {
    assert.ok(args.includes('core.fsmonitor=false'));
    assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { queueMicrotask(() => child.emit('close', null, signal)); };
    queueMicrotask(() => run(child)); return child;
  };
}
const hash = createHash('sha256'), expected = createHash('sha256');
const chunk = Buffer.alloc(1024 * 1024, 7);
await executionGit('/fixture', ['status'], { onData: b => hash.update(b), spawnProcess: fixture(child => {
  for (let i = 0; i < 24; i++) { child.stdout.write(chunk); expected.update(chunk); }
  child.emit('close', 0);
}) });
assert.equal(hash.digest('hex'), expected.digest('hex'), 'large status/diff evidence is streamed, not truncated at 16 MiB');
await assert.rejects(executionGit('/fixture', ['status'], { timeout: 15, spawnProcess: fixture(child => {
  child.stderr.write('PRIVATE upstream body and secret');
}) }), e => e.code === 'execution-git-timeout' && /timed out/.test(e.message) && !/PRIVATE|secret/.test(e.message));
await assert.rejects(executionGit('/fixture', ['config'], { spawnProcess: fixture(child => child.emit('close', 128)) }),
  e => e.code === 'execution-git-failed' && e.exitCode === 128, 'real repository failures are not mistaken for absent optional config');
await assert.rejects(executionGit('/fixture', ['rev-parse'], { maxBytes: 2, spawnProcess: fixture(child => child.stdout.write('large')) }),
  e => e.code === 'execution-git-output');
console.log('execution_git: streamed evidence, bounded scans, classified/redacted failures passed');
