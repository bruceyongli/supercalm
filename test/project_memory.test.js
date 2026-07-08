import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-pm-'));

const pm = await import('../src/agents/supervisor/project_memory.js');
const {
  createTask, getTask, amendTask, taskCard, listCriteria, addCriterion, supersedeCriterion,
  addEvidence, satisfyCriterion, setTaskStatus, listTasks,
  appendEvent, listEvents, addStandard, listStandards, upsertRuntime, getRuntime,
  renderCardMd, writeProjection, checkProjection, PROJECTION_FILE,
} = pm;
const { db } = await import('../src/store.js');

// ---- card lifecycle + immutable versions ----------------------------------------------------------
const card1 = createTask({
  projectId: 'p_test', sessionId: 's_test', title: 'Ship the widget',
  goal: 'Widget renders on the dashboard and survives reload.',
  criteria: ['Widget visible on dashboard', 'State survives a reload'],
});
{
  assert.equal(card1.task.version, 1);
  assert.equal(card1.criteria.length, 2);
  assert.ok(card1.hash?.length >= 12, 'card carries a content hash');
  const v1 = db.prepare('SELECT * FROM pm_task_versions WHERE task_id = ? AND version = 1').get(card1.task.id);
  assert.ok(v1, 'version 1 snapshot exists');
  assert.equal(v1.hash, card1.hash);
  const ev = listEvents({ projectId: 'p_test', types: ['opened'] });
  assert.equal(ev.length, 1, 'opened event recorded');
}

// amend bumps the version, snapshots are immutable, hash changes with the contract
{
  const before = card1.hash;
  const card2 = amendTask(card1.task.id, { goal: 'Widget renders AND is keyboard-accessible.' }, { actor: 'operator', summary: 'a11y scope added' });
  assert.equal(card2.task.version, 2);
  assert.notEqual(card2.hash, before, 'contract change changes the hash');
  const v1 = db.prepare('SELECT * FROM pm_task_versions WHERE task_id = ? AND version = 1').get(card1.task.id);
  assert.equal(v1.hash, before, 'v1 snapshot untouched by the amend');
}

// ---- criteria: supersede-not-edit keeps the temporal record ---------------------------------------
{
  const c = listCriteria(card1.task.id)[0];
  const newId = supersedeCriterion(c.id, 'Widget visible on dashboard on mobile AND desktop');
  const all = listCriteria(card1.task.id, { includeInactive: true });
  const old = all.find((x) => x.id === c.id);
  assert.equal(old.status, 'superseded');
  assert.ok(old.superseded_at, 'old criterion keeps its validity end');
  assert.equal(old.superseded_by, newId);
  assert.ok(listCriteria(card1.task.id).every((x) => x.status !== 'superseded'), 'live view excludes superseded');
}

// ---- evidence per criterion -----------------------------------------------------------------------
{
  const c = listCriteria(card1.task.id).find((x) => x.status === 'open');
  const eid = addEvidence({ taskId: card1.task.id, criterionId: c.id, kind: 'test_output', ref: 'npm test #42', summary: 'suite green incl. reload spec' });
  assert.ok(satisfyCriterion(c.id, eid));
  const after = listCriteria(card1.task.id, { includeInactive: true }).find((x) => x.id === c.id);
  assert.equal(after.status, 'satisfied');
  assert.equal(after.evidence_id, eid);
  assert.equal(satisfyCriterion(c.id, eid), false, 'cannot satisfy twice');
}

// ---- status transitions + closing events ----------------------------------------------------------
{
  setTaskStatus(card1.task.id, 'verify_pending', { actor: 'supervisor', sessionId: 's_test' });
  const done = setTaskStatus(card1.task.id, 'done', { actor: 'supervisor', outcome: 'shipped in v9.9' });
  assert.equal(done.task.status, 'done');
  assert.ok(done.task.closed_at);
  assert.equal(done.task.outcome, 'shipped in v9.9');
  const closed = listEvents({ projectId: 'p_test', types: ['closed'] });
  assert.equal(closed.length, 1);
  assert.match(closed[0].summary, /done/);
  assert.deepEqual(listTasks('p_test', { statuses: ['done'] }).map((t) => t.id), [card1.task.id]);
}

// ---- events: file-overlap retrieval (the pre-action gate's query) ---------------------------------
{
  appendEvent({ projectId: 'p_test', actor: 'supervisor', type: 'verify_fail', summary: 'reload loses state — fix attempt A rejected', refs: { files: ['web/widget.js', 'src/state.js'] } });
  appendEvent({ projectId: 'p_test', actor: 'supervisor', type: 'verify_fail', summary: 'unrelated css fail', refs: { files: ['web/styles.css'] } });
  appendEvent({ projectId: 'p_test', actor: 'supervisor', type: 'deploy', summary: 'v9.9 deployed', refs: { files: ['web/widget.js'] } });
  const hits = listEvents({ projectId: 'p_test', types: ['verify_fail'], files: ['src/state.js', 'web/nope.js'] });
  assert.equal(hits.length, 1, 'overlap filter matches on any shared file');
  assert.match(hits[0].summary, /fix attempt A/);
}

// ---- standards + session runtime ------------------------------------------------------------------
{
  addStandard('p_test', 'UI changes ship with a rendered screenshot as evidence.', { sourceRef: 'doctrine doc_x' });
  assert.equal(listStandards('p_test').length, 1);
  upsertRuntime('s_test', { project_id: 'p_test', branch: 'main', test_cmd: 'npm test' });
  upsertRuntime('s_test', { files_touched_json: JSON.stringify(['web/widget.js']) });
  const rt = getRuntime('s_test');
  assert.equal(rt.branch, 'main', 'partial upsert preserves earlier fields');
  assert.equal(rt.test_cmd, 'npm test');
}

// ---- projection: write / read-only / exclude / tamper / stale / foreign ---------------------------
{
  const repo = await mkdtemp(join(tmpdir(), 'pm-repo-'));
  await mkdir(join(repo, '.git', 'info'), { recursive: true });
  const card = createTask({ projectId: 'p_proj', title: 'Proj task', goal: 'g', criteria: ['c1'] });

  const w = writeProjection(repo, card);
  assert.equal(w.state, 'written');
  const md = await readFile(join(repo, PROJECTION_FILE), 'utf8');
  assert.match(md, /supercalm:task=/);
  assert.match(md, /Maintained by Supercalm/);
  assert.match(md, /- \[ \] c1/);
  const excl = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.ok(excl.split('\n').includes(PROJECTION_FILE), 'projection is repo-locally ignored');
  assert.equal(checkProjection(repo, card).state, 'ok');

  // tamper: builder edits the projection -> detected, not accepted
  await chmod(join(repo, PROJECTION_FILE), 0o644);
  await writeFile(join(repo, PROJECTION_FILE), md.replace('- [ ] c1', '- [x] c1 (totally done, trust me)'));
  assert.equal(checkProjection(repo, card).state, 'tampered');

  // stale: the card moved on, the file is an old projection (rewrite first so hash is valid again)
  writeProjection(repo, card, { force: true });
  const card2 = amendTask(card.task.id, { goal: 'g2' });
  assert.equal(checkProjection(repo, card2).state, 'stale');
  writeProjection(repo, card2, { force: true });
  assert.equal(checkProjection(repo, card2).state, 'ok');

  // foreign: an unmanaged GOAL.md is NEVER clobbered without force
  const repo2 = await mkdtemp(join(tmpdir(), 'pm-repo2-'));
  await writeFile(join(repo2, PROJECTION_FILE), '# My own goals\n- world domination\n');
  assert.equal(writeProjection(repo2, card2).state, 'foreign');
  assert.match(await readFile(join(repo2, PROJECTION_FILE), 'utf8'), /world domination/, 'foreign file untouched');
  assert.equal(checkProjection(repo2, card2).state, 'foreign');
  assert.equal(writeProjection(repo2, card2, { force: true }).state, 'written');

  // renderCardMd sanity for the satisfied checkbox path
  const cid = listCriteria(card2.task.id)[0].id;
  const eid = addEvidence({ taskId: card2.task.id, criterionId: cid, kind: 'terminal', summary: 'seen' });
  satisfyCriterion(cid, eid);
  assert.match(renderCardMd(taskCard(card2.task.id)), /- \[x\] c1/);
}

// ---- phase-1 contract: data-only, no behavior wiring ----------------------------------------------
{
  const sup = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
  assert.ok(!sup.includes('project_memory'), 'phase 1 is data-only: the supervisor must not import project_memory yet (this lock is REMOVED in phase 3)');
  const flags = readFileSync(new URL('../src/flags.js', import.meta.url), 'utf8');
  assert.match(flags, /projectMemory/, 'behavior phases gate on the projectMemory flag');
}

console.log('project_memory.test ok');
