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
  // Phase 3: the card IS the contract — the supervisor must read it (flag-gated), the maintainer
  // must stand down in card mode, and verify verdicts must become typed events on the card.
  const sup = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
  assert.match(sup, /from '\.\/supervisor\/project_memory\.js'/, 'supervisor reads the card store');
  assert.match(sup, /function applyActiveCard/, 'card-as-contract seam exists');
  assert.match(sup, /flagOn\('projectMemory'\)/, 'card mode is flag-gated');
  assert.match(sup, /cfg\.doc = renderCardMd\(card\)/, 'the card derives cfg.doc for every downstream reader');
  assert.match(sup, /&& !ctx\.__activeCard && !ctx\.__betweenTasks\) \{ \/\/ card mode: the maintainer stands down/, 'doc-maintainer stands down in card mode (and between tasks)');
  assert.match(sup, /type: parsed\.verdict === 'complete' \? 'verify_pass' : 'verify_fail'/, 'verify verdicts become card events');
  assert.match(sup, /ctx\.__activeCard = applyActiveCard\(ctx, cfg\)/, 'manual/sync runs judge the card too');
  const flags = readFileSync(new URL('../src/flags.js', import.meta.url), 'utf8');
  assert.match(flags, /projectMemory/, 'behavior phases gate on the projectMemory flag');
  const api = readFileSync(new URL('../src/pm_api.js', import.meta.url), 'utf8');
  assert.match(api, /api\/session\/:id\/tasks/, 'explicit task routes exist');
  const panel = readFileSync(new URL('../web/agents/supervisor.js', import.meta.url), 'utf8');
  assert.match(panel, /renderTaskCard/, 'panel renders the card view');
  assert.match(panel, /pmData\?\.active/, 'card view replaces the doc UI when a card is active');
}

// ---- between-tasks: the next card can be proposed, and the panel never headlines a closed card -----
{
  const sup8 = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
  assert.match(sup8, /ctx\.__activeCard \|\| ctx\.__betweenTasks\) await maybeSuggestBoundary/, 'boundary suggestions run between tasks (the stuck-on-done-card bug)');
  assert.match(sup8, /parsed\.fit = 'new'; \/\/ nothing to amend between tasks/, 'between-tasks amend upgrades to new');
  const api8 = readFileSync(new URL('../src/pm_api.js', import.meta.url), 'utf8');
  assert.match(api8, /a closed card is history, not the current contract/, 'tasks payload demotes closed cards');
  const panel8 = readFileSync(new URL('../web/agents/supervisor.js', import.meta.url), 'utf8');
  assert.match(panel8, /Between tasks — last:/, 'panel shows the between-tasks state');
}

// ---- card-first + stale-proposal hygiene ----------------------------------------------------------
{
  const { expireStaleMigrationProposals } = pm;
  // dead-driver proposal expires; fresh live-driver proposal survives
  db.prepare("INSERT OR REPLACE INTO sessions (id, project_id, tool, tmux, status, started_at, last_activity) VALUES ('s_dead','p_exp','codex','tmx_d','exited', 1, 1)").run();
  db.prepare("INSERT OR REPLACE INTO sessions (id, project_id, tool, tmux, status, started_at, last_activity) VALUES ('s_live2','p_exp','codex','tmx_l','waiting', 1, 1)").run();
  const dm2 = await import('../src/agents/supervisor/doc_migration.js');
  const doc = '# T\n## Now\nX\n## Acceptance criteria\n- [ ] c';
  const a = await dm2.proposeMigration({ sessionId: 's_dead', projectId: 'p_exp', doc, call: null });
  const b = await dm2.proposeMigration({ sessionId: 's_live2', projectId: 'p_exp', doc, call: null });
  const n = expireStaleMigrationProposals();
  assert.ok(n >= 1, 'dead-driver proposal expired');
  assert.equal(pm.getTask(a.card.task.id).status, 'abandoned');
  assert.equal(pm.getTask(b.card.task.id).status, 'proposed', 'live fresh proposal survives');
  const old3 = pm.getTask(b.card.task.id);
  db.prepare('UPDATE pm_tasks SET created_at = ? WHERE id = ?').run(Date.now() - 80 * 3600e3, b.card.task.id);
  expireStaleMigrationProposals();
  assert.equal(pm.getTask(b.card.task.id).status, 'abandoned', '72h-old proposal expires');

  const api9 = readFileSync(new URL('../src/pm_api.js', import.meta.url), 'utf8');
  assert.match(api9, /expireStaleMigrationProposals\(\)/, 'lazy expiry on the tasks read');
  assert.match(api9, /mine: t\.driven_by_session === sid/, 'proposals carry ownership');
  const panel9 = readFileSync(new URL('../web/agents/supervisor.js', import.meta.url), 'utf8');
  assert.match(panel9, /t\.status === 'proposed' && t\.mine/, 'migration banner only for the owning session');
  assert.match(panel9, />Dismiss</, 'a real Dismiss exists');
  assert.match(panel9, /Legacy doc \(retired/, 'legacy doc demoted behind the card shell');
  assert.ok(!panel9.includes('Keep legacy doc'), 'the confusing keep-doc label is gone');
}

console.log('project_memory.test ok');

// ---- phase 4: project awareness ---------------------------------------------------------------------
{
  const { liveOverlaps, deriveVerifyFacts, pinVerifyFacts } = pm;
  // two live sessions on one project touching intersecting files -> overlap named; fresh/live filters hold
  db.prepare("INSERT OR REPLACE INTO sessions (id, project_id, tool, tmux, status, started_at, last_activity) VALUES ('s_pm_a','p_ov','codex','tmx_s_pm_a','working', 1, 1)").run();
  db.prepare("INSERT OR REPLACE INTO sessions (id, project_id, tool, tmux, status, started_at, last_activity) VALUES ('s_pm_b','p_ov','codex','tmx_s_pm_b','waiting', 1, 1)").run();
  db.prepare("INSERT OR REPLACE INTO sessions (id, project_id, tool, tmux, status, started_at, last_activity) VALUES ('s_pm_dead','p_ov','codex','tmx_s_pm_dead','exited', 1, 1)").run();
  pm.upsertRuntime('s_pm_b', { project_id: 'p_ov', active_task_id: 'task_ovB', files_touched_json: JSON.stringify(['src/a.js', 'src/b.js']) });
  pm.upsertRuntime('s_pm_dead', { project_id: 'p_ov', files_touched_json: JSON.stringify(['src/a.js']) });
  const hits = liveOverlaps('s_pm_a', 'p_ov', ['src/a.js', 'web/x.css']);
  assert.equal(hits.length, 1, 'live overlap found; exited session excluded');
  assert.equal(hits[0].sessionId, 's_pm_b');
  assert.deepEqual(hits[0].overlap, ['src/a.js']);
  assert.equal(hits[0].taskId, 'task_ovB');
  assert.equal(liveOverlaps('s_pm_a', 'p_ov', ['web/only.css']).length, 0, 'no shared files -> no conflict');
  // stale runtimes don't fire
  db.prepare('UPDATE pm_session_runtime SET updated_at = ? WHERE session_id = ?').run(Date.now() - 3600e3, 's_pm_b');
  assert.equal(liveOverlaps('s_pm_a', 'p_ov', ['src/a.js']).length, 0, 'stale runtime ignored');

  // verify facts from manifests, pinned once (COALESCE keeps the original pin)
  const repo3 = await mkdtemp(join(tmpdir(), 'pm-facts-'));
  await writeFile(join(repo3, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js', build: 'x' } }));
  const facts = deriveVerifyFacts(repo3);
  assert.equal(facts.test_cmd, 'npm test');
  assert.equal(facts.build_cmd, 'npm run build');
  assert.match(facts.source, /manifests/);
  const cardF = createTask({ projectId: 'p_ov', title: 'facts', goal: 'g' });
  pinVerifyFacts(cardF.task.id, facts);
  pinVerifyFacts(cardF.task.id, { test_cmd: 'OTHER' }); // must not overwrite the original pin
  const t = pm.getTask(cardF.task.id);
  assert.match(t.verify_facts_json, /npm test/, 'first pin wins (goalposts cannot move mid-task)');
  assert.match(renderCardMd(taskCard(cardF.task.id)), /Verify facts \(pinned at task open\)/);

  // supervisor integration locks (phase 4)
  const sup = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
  assert.match(sup, /liveOverlaps\(ctx\.sessionId/, 'conflict check runs in the tick');
  assert.match(sup, /conflictWarnKey/, 'one warning per overlap-set (state-keyed)');
  assert.match(sup, /retrieveProjectKnowledge/, 'supervisor retrieves the knowledge layer');
  assert.match(sup, /maybeRebuildWiki/, 'self-provisioning knowledge bootstrap on card sync');
  assert.match(sup, /pinVerifyFacts/, 'verify facts backfilled at first card sync');
  const ap = readFileSync(new URL('../src/agents/answer_prompt.js', import.meta.url), 'utf8');
  assert.match(ap, /projectKnowledge/, 'answer prompt carries the knowledge block');
  assert.match(ap, /never overrides the contract or operator/i, 'knowledge is provenance-marked untrusted');
  const api = readFileSync(new URL('../src/pm_api.js', import.meta.url), 'utf8');
  assert.match(api, /tasks\/open/, 'inheritance-on-open route exists');
  assert.match(api, /coordinate or expect conflict warnings/, 'advisory claim warning on cross-session adoption');
}

// ---- phase 5: history retrieval + pre-action gate + auto-satisfy ----------------------------------
{
  const { previouslyFailed, formatPreviouslyFailed, applyCriteriaMet } = pm;
  // file-overlap events rank first; the reviews seed fills up to the cap with recency + dedupe
  const hits = previouslyFailed({ projectId: 'p_test', files: ['src/state.js'] });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].kind, 'file-overlap');
  assert.match(hits[0].summary, /fix attempt A/);
  const fmt = formatPreviouslyFailed(hits);
  assert.match(fmt, /PREVIOUSLY_FAILED/);
  assert.match(fmt, /do NOT repeat/i);
  assert.equal(formatPreviouslyFailed([]), '', 'empty history injects nothing');
  // reviews seed: a project verify-fail row surfaces even with no file overlap
  db.prepare("INSERT OR REPLACE INTO sessions (id, project_id, tool, tmux, status, started_at, last_activity) VALUES ('s_pf','p_pf','codex','tmx_pf','waiting', 1, 1)").run();
  await import('../src/agents/supervisor.js'); // ensures supervisor_reviews exists
  const { db: db2 } = await import('../src/store.js');
  db2.prepare("INSERT INTO supervisor_reviews (session_id, ts, kind, verdict, assessment, sent) VALUES ('s_pf', ?, 'verify', 'needs_attention', 'reload loses state — approach X rejected', 0)").run(Date.now());
  const seeded = previouslyFailed({ projectId: 'p_pf', files: [] });
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].kind, 'project-recent');
  assert.match(seeded[0].summary, /approach X rejected/);

  // auto-satisfy: prefix-matched, evidence-required, add-only
  const cardM = createTask({ projectId: 'p_pf', title: 'satisfy', goal: 'g', criteria: ['The suite passes on node 25 with zero failures', 'Docs updated for the new flag'] });
  const n = applyCriteriaMet(cardM.task.id, [
    { text_prefix: 'The suite passes on node 25', evidence: 'npm test output: 25 groups green' },
    { text_prefix: 'Something not on the card', evidence: 'x' },
    { text_prefix: 'Docs updated', evidence: '' }, // no evidence -> ignored
  ]);
  assert.equal(n, 1, 'only the evidenced, matching criterion satisfies');
  const crits = listCriteria(cardM.task.id, { includeInactive: true });
  const sat = crits.find((c) => c.status === 'satisfied');
  assert.match(sat.text, /suite passes/);
  assert.ok(sat.evidence_id, 'satisfaction recorded an evidence row');
  assert.equal(applyCriteriaMet(cardM.task.id, [{ text_prefix: 'The suite passes on node 25', evidence: 'again' }]), 0, 'already-satisfied never re-satisfies');

  // source locks
  const sup = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
  assert.match(sup, /priorFailuresFor/, 'pre-action gate helper exists');
  assert.match(sup, /previouslyFailed: priorFailuresFor\(ctx, ev\)/, 'answer path carries failure history');
  assert.match(sup, /prior_failures: priorFailures/, 'verify evidence carries failure history');
  // placement lock (a phase-5 live 500: these consts once landed inside runUnstick, which lacks
  // sess/ctxData — assert they live in runVerify's scope, between the doctrine block and evidence)
  const vSeg = sup.slice(sup.indexOf("doctrine retrieve failed"), sup.indexOf('verify_prompt_version: VERIFY_PROMPT_VERSION'));
  assert.match(vSeg, /retrieveProjectKnowledge/, 'projectKnowledge defined in runVerify scope');
  assert.match(vSeg, /priorFailuresFor/, 'priorFailures defined in runVerify scope');
  const uSeg = sup.slice(sup.indexOf('async function runUnstick'), sup.indexOf('async function runUnstick') + 900);
  assert.ok(!uSeg.includes('retrieveProjectKnowledge'), 'runUnstick must not reference verify-scope vars');
  assert.match(uSeg, /unstickPriorFailures/, 'unstick has its own correctly-built pre-action gate');
  assert.match(sup, /TASK_CARD_ADDENDUM/, 'verifier asked for per-criterion evidence in card mode');
  assert.match(sup, /applyCriteriaMet\(ctx\.__activeCard\.task\.id, rawParsed\?\.criteria_met\)/, 'verify auto-satisfies cited criteria');
  assert.match(sup, /maybeSuggestBoundary/, 'boundary suggestions run in card mode');
  assert.match(sup, /pendingBoundary/, 'suggestion persists for the panel');
  const ap2 = readFileSync(new URL('../src/agents/answer_prompt.js', import.meta.url), 'utf8');
  assert.match(ap2, /previouslyFailed/, 'answer prompt renders the failure block');
  const api2 = readFileSync(new URL('../src/pm_api.js', import.meta.url), 'utf8');
  assert.match(api2, /tasks\/boundary/, 'boundary accept/dismiss route exists');
  const sess = readFileSync(new URL('../web/session.js', import.meta.url), 'utf8');
  assert.match(sess, /aios:new-task/, '/task palette command wired');
}

// ---- phase 6: lazy migration -----------------------------------------------------------------------
{
  const dm = await import('../src/agents/supervisor/doc_migration.js');
  const LEGACY = `# Fix the widget and prep release
## Goal
Original day-one goal: rebuild the widget pipeline end to end.
## Now
Ship the widget cache fix and verify reload behavior.
## Hard rules
- Evidence must be real: diffs, command output, passing tests; prose alone is not enough.
- Do not treat ~/tmp/old_design_handoff as the current project goal.
- Supervisor stage awareness must stand down during planning (shipped in stage.js).
- Only inspect logs during this investigation; do not modify code.
- The service runs on port 8793 behind the tailnet proxy.
## Acceptance criteria
- [x] Old finished thing nobody cares about
- [ ] Widget cache survives reload
- [ ] Cache hit rate is visible in the dashboard
## Timeline
- lots of history here
`;
  // deterministic parse: title, Now-first trust order, unchecked criteria only
  const parsed = dm.parseLegacyDoc(LEGACY);
  assert.equal(parsed.title, 'Fix the widget and prep release');
  assert.match(parsed.now, /widget cache fix/);
  assert.deepEqual(parsed.criteria, ['Widget cache survives reload', 'Cache hit rate is visible in the dashboard']);
  assert.equal(parsed.hardRules.length, 5);

  // classification validation: clamps, unknown buckets -> fossil, exactly-once
  const v = dm.validateMigrateResult({ lines: [
    { i: 0, bucket: 'doctrine', rewrite: 'Never accept completion claims without concrete evidence (diffs, command output, tests).' },
    { i: 1, bucket: 'patch' }, { i: 2, bucket: 'fossil' }, { i: 3, bucket: 'constraint' }, { i: 4, bucket: 'fact' },
    { i: 0, bucket: 'patch' }, { i: 99, bucket: 'doctrine' }, { i: 1, bucket: 'bogus' },
  ] }, parsed.hardRules);
  assert.equal(v.size, 5);
  assert.equal(v.get(0).bucket, 'doctrine');
  assert.equal(v.get(1).bucket, 'patch');

  // full proposal: proposed status (never active), Now-seeded goal, verbatim archive, buckets routed
  const call = async () => JSON.stringify({ lines: [
    { i: 0, bucket: 'doctrine', rewrite: 'Never accept completion claims without concrete evidence (diffs, command output, tests).' },
    { i: 1, bucket: 'patch' }, { i: 2, bucket: 'fossil' }, { i: 3, bucket: 'constraint' }, { i: 4, bucket: 'fact' },
  ] });
  const before = db.prepare("SELECT COUNT(*) c FROM supervisor_doctrine WHERE source = 'doc-migration'").get().c;
  const r = await dm.proposeMigration({ sessionId: 's_mig', projectId: 'p_mig', doc: LEGACY, call });
  assert.equal(r.card.task.status, 'proposed', 'migration proposes, never activates');
  assert.match(r.card.task.goal, /^Ship the widget cache fix/, '## Now outranks ## Goal');
  assert.match(r.card.task.goal, /Constraints: Only inspect logs/, 'live constraints ride the card');
  assert.equal(r.card.criteria.length, 2, 'only unchecked criteria carried');
  const row = db.prepare('SELECT legacy_doc FROM pm_tasks WHERE id = ?').get(r.card.task.id);
  assert.equal(row.legacy_doc, LEGACY, 'original archived VERBATIM on the card');
  assert.equal(r.counts.dropped, 2, 'fossil + anti-staleness patch dropped');
  assert.equal(r.counts.facts, 1);
  const after = db.prepare("SELECT COUNT(*) c FROM supervisor_doctrine WHERE source = 'doc-migration'").get().c;
  assert.equal(after - before, 1, 'one doctrine candidate (evidence rule), deduped + capped');
  const ev6 = listEvents({ projectId: 'p_mig', types: ['legacy_doc'] });
  assert.equal(ev6.length, 1);
  assert.match(ev6[0].summary, /archived verbatim/);
  // re-proposing the same doctrine text dedupes (near-dup skip)
  const r2 = await dm.proposeMigration({ sessionId: 's_mig2', projectId: 'p_mig', doc: LEGACY, call });
  const after2 = db.prepare("SELECT COUNT(*) c FROM supervisor_doctrine WHERE source = 'doc-migration'").get().c;
  assert.equal(after2, after, 'near-dup doctrine candidate skipped on second migration');
  // fail-open: no call -> card still proposed, zero doctrine, everything archived
  const r3 = await dm.proposeMigration({ sessionId: 's_mig3', projectId: 'p_mig3', doc: LEGACY, call: null });
  assert.equal(r3.card.task.status, 'proposed');
  assert.equal(r3.counts.doctrine, 0);

  // source locks: onTick proposes once (hot only), panel banners + decline exist
  const sup6 = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
  assert.match(sup6, /tier === 'hot' && cfg\.doc && cfg\.doc\.trim\(\) && !st\.migrationProposedAt/, 'lazy: hot-tier, once, doc present, no card');
  assert.match(sup6, /migrationProposedAt: t/, 'once-per-session state mark');
  const panel6 = readFileSync(new URL('../web/agents/supervisor.js', import.meta.url), 'utf8');
  assert.match(panel6, /Card drafted from this session's old doc/, 'migration banner');
  assert.match(panel6, />Dismiss</, 'decline path');
  const api6 = readFileSync(new URL('../src/pm_api.js', import.meta.url), 'utf8');
  assert.match(api6, /legacy: !!t\.legacy_doc/, 'tasks route flags migrated cards');
}

// ---- polish: auto-close, operator-satisfy, between-tasks, no native dialogs ------------------------
{
  const { allCriteriaSatisfied, renderBetweenTasksMd } = pm;
  const cardX = createTask({ projectId: 'p_pol', title: 'polish', goal: 'g', criteria: ['a1 must hold', 'b2 must hold'] });
  assert.equal(allCriteriaSatisfied(cardX.task.id), false);
  for (const c of listCriteria(cardX.task.id)) {
    const eid = addEvidence({ taskId: cardX.task.id, criterionId: c.id, kind: 'operator', summary: 'confirmed' });
    satisfyCriterion(c.id, eid);
  }
  assert.equal(allCriteriaSatisfied(cardX.task.id), true, 'all satisfied detected');
  const empty = createTask({ projectId: 'p_pol', title: 'no crits', goal: 'g' });
  assert.equal(allCriteriaSatisfied(empty.task.id), false, 'zero criteria never counts as all-satisfied');
  const btm = renderBetweenTasksMd({ id: 't1', title: 'Widget fix', status: 'done', outcome: 'shipped' });
  assert.match(btm, /Between tasks/);
  assert.match(btm, /NO active contract/);
  assert.match(btm, /Widget fix/);

  const sup7 = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
  assert.match(sup7, /allCriteriaSatisfied\(tid2\)/, 'gate-verified auto-close checks every criterion');
  assert.match(sup7, /pmSetTaskStatus\(tid2, 'done'/, 'complete + all satisfied -> done, no manual click needed');
  assert.match(sup7, /pmSetTaskStatus\(tid2, 'verify_pending'/, 'complete with open criteria -> visible verify_pending');
  assert.match(sup7, /must NOT expand this verdict/, 'card defines the task scope — DoD/spec cannot expand it (round-2: no silent scope expansion)');
  assert.match(sup7, /do not re-litigate them/, 'satisfied criteria carry recorded evidence');
  assert.match(sup7, /renderBetweenTasksMd/, 'closed card -> between-tasks contract, never the legacy monolith');
  assert.match(sup7, /__betweenTasks/, 'maintainer/migration respect the between-tasks state');
  const api7 = readFileSync(new URL('../src/pm_api.js', import.meta.url), 'utf8');
  assert.match(api7, /criteria\/:cid\/satisfy/, 'operator-satisfy route exists');
  assert.match(api7, /kind: 'operator'/, 'operator judgment recorded as first-class evidence');
  const panel7 = readFileSync(new URL('../web/agents/supervisor.js', import.meta.url), 'utf8');
  const pmSeg = panel7.slice(panel7.indexOf('function renderTaskCard'), panel7.indexOf('function renderDoc'));
  assert.ok(!/\bprompt\(|\bconfirm\(|\balert\(/.test(pmSeg), 'task-card flows use inline editors, never native dialogs');
  assert.match(pmSeg, /data-pm-satisfy/, 'open criteria are clickable');
  assert.match(pmSeg, /pm-arch-outcome/, 'archive rows restyled');
}
