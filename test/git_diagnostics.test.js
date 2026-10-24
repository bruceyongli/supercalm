import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitOut } from '../src/git.js';

const root = await mkdtemp(join(tmpdir(), 'aios-git-diagnostics-'));
const originalPath = process.env.PATH;
try {
  const missing = await gitOut(join(root, 'missing'), ['rev-parse', '--git-dir']);
  assert.ok(missing.error); assert.equal(missing.text, '');
  assert.equal(missing.diagnostics.code, 128); assert.equal(missing.diagnostics.signal, null);
  assert.equal(missing.diagnostics.timedOut, false); assert.match(missing.diagnostics.stderr, /cannot change|No such file/i);

  const bin = join(root, 'bin'); await mkdir(bin);
  const mock = join(bin, 'git');
  await writeFile(mock, '#!/bin/sh\nexec /bin/sleep 60\n');
  await chmod(mock, 0o755); process.env.PATH = bin + ':' + originalPath;
  const timed = await gitOut(root, ['rev-parse', '--git-dir'], { timeout: 150 });
  assert.ok(timed.error); assert.equal(timed.text, '');
  assert.equal(timed.diagnostics.code, null); assert.equal(timed.diagnostics.signal, 'SIGKILL');
  assert.equal(timed.diagnostics.killed, true); assert.equal(timed.diagnostics.timedOut, true);
  assert.equal(timed.diagnostics.timeoutMs, 150); assert.ok(timed.diagnostics.elapsedMs >= 150);
  assert.equal(timed.diagnostics.stderr, '', 'a timeout may have no stderr, unlike the fatal Git exit above');
  assert.equal(Object.hasOwn(timed.diagnostics, 'env'), false);
  console.log('git diagnostics: exit status, stderr, kill signal, and timeout preserved without environment values');
} finally { process.env.PATH = originalPath; await rm(root, { recursive: true, force: true }); }
