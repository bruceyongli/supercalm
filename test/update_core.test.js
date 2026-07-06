import assert from 'node:assert/strict';
const { cmpVersion, parseLatest } = await import('../src/update_core.js');

// version comparison — incl. the classic 0.1.9 vs 0.1.10 string-compare trap
assert.equal(cmpVersion('0.1.10', '0.1.9'), 1);
assert.equal(cmpVersion('0.1.9', '0.1.10'), -1);
assert.equal(cmpVersion('v0.1.216', '0.1.216'), 0);
assert.equal(cmpVersion('1.0.0', '0.99.99'), 1);
assert.equal(cmpVersion('0.2', '0.2.0'), 0);
assert.equal(cmpVersion('', '0.0.1'), -1);

// GitHub release payload
const rel = parseLatest('release', { tag_name: 'v0.1.217', html_url: 'https://github.com/o/r/releases/tag/v0.1.217', name: 'v0.1.217 — hardening' }, 'o/r');
assert.deepEqual(rel, { version: '0.1.217', url: 'https://github.com/o/r/releases/tag/v0.1.217', name: 'v0.1.217 — hardening' });
// package.json fallback
assert.deepEqual(parseLatest('package', { version: '0.1.218' }, 'o/r'), { version: '0.1.218', url: 'https://github.com/o/r/releases', name: '' });
// malformed -> null (fail-open)
assert.equal(parseLatest('release', {}, 'o/r'), null);
assert.equal(parseLatest('package', null, 'o/r'), null);

console.log('update_core.test ok');
