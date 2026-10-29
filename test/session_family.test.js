import assert from 'node:assert/strict';
import { sessionFamilies, parentSessionLabel, relatedSessionOrder, needsSessionAttention } from '../web/session-family.js';
import { childSessionTitle } from '../src/session_title.js';

const now = Date.now();
const rows = [
  { id: 'child', parent_session_id: 'main', project: 'same', title: '手机端验收', status: 'working', last_activity: now },
  { id: 'independent', project: 'same', title: 'Other task', status: 'working', last_activity: now },
  { id: 'main', project: 'same', title: 'Improve the learning page', status: 'waiting', last_activity: 1 },
  { id: 'stopped', parent_session_id: 'main', status: 'exited', last_activity: 10 },
  { id: 'grandchild', parent_session_id: 'child', project: 'cross-project', status: 'waiting', last_activity: 20 },
  { id: 'orphan', parent_session_id: 'missing', status: 'working' },
  { id: 'cycle-a', parent_session_id: 'cycle-b', status: 'working' },
  { id: 'cycle-b', parent_session_id: 'cycle-a', status: 'working' },
  { id: 'self', parent_session_id: 'self', status: 'working' },
];
const before = structuredClone(rows);
const families = sessionFamilies(rows);
const main = families.find(f => f.id === 'main');
assert.deepEqual(main.helpers.map(s => s.id), ['child', 'stopped', 'grandchild']);
assert.equal(main.last_activity, now, 'new helper work keeps its family visible without touching the parent clock');
assert.equal(main.root.last_activity, 1);
assert.equal(families.find(f => f.id === 'independent').helpers.length, 0, 'project name is not ownership');
assert.equal(families.find(f => f.id === 'orphan').root.id, 'orphan');
assert.equal(new Set(families.flatMap(f => f.members.map(s => s.id))).size, rows.length, 'orphans/cycles lose no rows');
assert.equal(families.flatMap(f => f.members).length, rows.length, 'no duplicate rows');
assert.deepEqual(rows, before, 'presentation cannot rewrite activity, lifecycle or names');
assert.equal(parentSessionLabel(rows[0], rows), 'Improve the learning page');
const reports = [rows[0], rows[1], rows[2], rows[4]];
assert.deepEqual(relatedSessionOrder(reports, rows).map(s => s.id), ['child', 'main', 'grandchild', 'independent']);
assert.equal(needsSessionAttention({status:'waiting', unread:1, category:'decision'}), true);
assert.equal(needsSessionAttention({status:'waiting', unread:1, category:'decision', dismissed:true}), false);
assert.equal(needsSessionAttention({status:'working', unread:1, category:'decision', pending_input:true}), true);

assert.equal(childSessionTitle('  手机端验收  ', 'complete task'), '手机端验收');
assert.equal(childSessionTitle('mobile_layout_review', 'complete task'), 'mobile layout review');
assert.equal(childSessionTitle(null, 'You are an assistant.\nTask: Login regression\nLong task details'), 'Login regression');
assert.equal(childSessionTitle(undefined, ''), 'Helper');
assert(childSessionTitle('x'.repeat(100), '').length <= 48);
assert.equal(childSessionTitle('\0 Name\nwith\tcontrols ', ''), 'Name with controls');
console.log('session_family: explicit ancestry, stable grouping, cycle/orphan safety, unchanged data and short helper names passed');
