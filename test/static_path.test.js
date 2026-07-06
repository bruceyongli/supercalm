import assert from 'node:assert/strict';
import { confinedPath } from '../src/static_path.js';

const root = '/Users/host/aios/web';

assert.equal(confinedPath(root, '/index.html'), '/Users/host/aios/web/index.html');
assert.equal(confinedPath(root, '/vendor/xterm.js'), '/Users/host/aios/web/vendor/xterm.js');
assert.equal(confinedPath(root, '/../web2/secret.txt'), null);
assert.equal(confinedPath(root, '/../web/../web2/secret.txt'), null);
assert.equal(confinedPath(root, '/../package.json'), null);

console.log('static_path.test ok');
