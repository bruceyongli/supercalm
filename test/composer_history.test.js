import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';

// AIOS sessions intentionally redirect TMPDIR into their own session-storage tree. This database is a
// true isolated test writer, so keep it outside the canonical data directory guarded by store.js.
process.env.AIOS_DATA = await mkdtemp(join('/tmp', 'aios-composer-history-'));
const store = await import('../src/store.js');

store.addEvent('s_history', 'composer-draft-archived', {
  text: 'Keep the earlier terminal idea available.',
  displaced_by: 'voice',
});
store.addEvent('s_history', 'input', { source: 'voice', len: 24 });
store.addEvent('s_history', 'composer-draft-archived', {
  text: 'A second displaced draft.',
  displaced_by: 'text',
});
store.db.prepare("INSERT INTO events (session_id,ts,type,payload) VALUES (?,?,?,?)")
  .run('s_history', Date.now(), 'composer-draft-archived', '{bad json');

assert.deepEqual(
  store.composerDraftHistoryFor('s_history').map((entry) => entry.text),
  ['Keep the earlier terminal idea available.', 'A second displaced draft.'],
  'durable composer history returns displaced drafts in recall order and ignores malformed events',
);
assert.deepEqual(store.composerDraftHistoryFor('s_other'), []);

store.db.close();
console.log('composer_history.test ok');
