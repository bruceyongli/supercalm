import assert from 'node:assert/strict';

import { assertCompleteReleaseSource } from '../src/release_contract.js';

assert.throws(
  () => assertCompleteReleaseSource('/tmp/release', ''),
  /source_dir and source_branch must be configured together/,
  'source directory without a branch is rejected',
);
assert.throws(
  () => assertCompleteReleaseSource('', 'release/production'),
  /source_dir and source_branch must be configured together/,
  'source branch without a directory is rejected',
);
assert.equal(assertCompleteReleaseSource('/tmp/release', 'release/production'), true, 'complete source contract accepted');
assert.equal(assertCompleteReleaseSource('', ''), false, 'monitor-only target has no deploy contract');

console.log('release_source_contract.test: all assertions passed');
