import assert from 'node:assert/strict';
import { createSessionRequestScope, isSessionAbort } from '../web/session-request-scope.js';

const scope = createSessionRequestScope('s_one');
const first = scope.capture();
assert.equal(first.id, 's_one');
assert.equal(scope.isCurrent(first), true);

const second = scope.switchTo('s_two');
assert.equal(first.signal.aborted, true, 'switch aborts in-flight work from the previous session');
assert.equal(scope.isCurrent(first), false);
assert.equal(scope.isCurrent(second), true);
assert.throws(() => scope.guard(first, 'late'), (error) => isSessionAbort(error));
assert.equal(scope.guard(second, 'fresh'), 'fresh');

scope.destroy();
assert.equal(second.signal.aborted, true);
assert.equal(scope.isCurrent(second), false);

console.log('session_request_scope.test ok');
