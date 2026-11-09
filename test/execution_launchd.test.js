import assert from 'node:assert/strict';
import { bootstrapExecutionService } from '../src/execution_launchd.js';
let calls = 0, waits = 0;
await bootstrapExecutionService(async (command, args) => {
  assert.equal(command, '/bin/launchctl'); assert.deepEqual(args, ['bootstrap', 'gui/501', '/owned/executor.plist']);
  if (++calls < 3) throw Object.assign(Error('retiring'), { code: 5 });
}, 'gui/501', '/owned/executor.plist', { wait: async () => waits++ });
assert.equal(calls, 3); assert.equal(waits, 2);
calls = 0;
await assert.rejects(bootstrapExecutionService(async () => { calls++; throw Object.assign(Error('permission'), { code: 13 }); }, 'gui/501', '/owned/executor.plist', { wait: async () => {} }), /permission/);
assert.equal(calls, 1);
calls = 0;
await assert.rejects(bootstrapExecutionService(async () => { calls++; throw Object.assign(Error('not transient'), { code: 5 }); }, 'gui/501', '/owned/executor.plist', { attempts: 3, wait: async () => {} }), /not transient/);
assert.equal(calls, 3);
console.log('execution_launchd: transient retirement race retried; failures bounded and scoped');
