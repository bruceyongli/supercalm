import test from 'node:test';
import assert from 'node:assert/strict';
import { localBuildSize } from '../src/local_build_size.js';

const root = '/private/tmp/owned-build';
test('complete du total retains exact byte accounting', () => {
  assert.deepEqual(localBuildSize({ stdout: '123\t' + root + '\n', stderr: '' }, root), { bytes: 123 * 1024, vanishedDuringScan: 0 });
});
test('only vanished descendants in a live tree may accompany a complete total', () => {
  assert.deepEqual(localBuildSize({ code: 1, stdout: '123\t' + root + '\n', stderr: 'du: ' + root + '/cache/npm/tmp/gone: No such file or directory\n' }, root), { bytes: 123 * 1024, vanishedDuringScan: 1 });
});
test('permissions, foreign paths and unexplained failures still refuse', () => {
  for (const stderr of ['du: ' + root + '/cache: Permission denied\n', 'du: /other/gone: No such file or directory\n', ''])
    assert.throws(() => localBuildSize({ code: 1, stdout: '123\t' + root + '\n', stderr }, root));
});
test('timeouts, signals and max-buffer errors cannot look like vanished files', () => {
  for (const change of [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, { killed: true }, { signal: 'SIGTERM' }])
    assert.throws(() => localBuildSize({ code: 1, stdout: '123\t' + root + '\n', stderr: 'du: ' + root + '/gone: No such file or directory\n', ...change }, root));
});
test('missing, foreign, non-numeric and truncated totals refuse', () => {
  for (const stdout of ['', '123', '123\t/other\n', 'bad\t' + root, '123\t' + root + '\nextra'])
    assert.throws(() => localBuildSize({ stdout, stderr: '' }, root));
});
test('large valid totals remain large so the unchanged caller cap still rejects', () => {
  const total = localBuildSize({ stdout: String(31 * 1024 * 1024) + '\t' + root + '\n', stderr: '' }, root);
  assert.ok(total.bytes > 30 * 1024 ** 3);
});
