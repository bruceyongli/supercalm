// Supervisor full-auto card management on operator composer messages (Part 3). The classify step runs
// inside maybeSuggestBoundary (needs the tick ctx + an LLM), so here we (1) exercise the exact pm
// primitive chain the full-auto path performs — create + activate + point the session runtime at it,
// then amend — in a temp DB, and (2) source-lock the wiring + guard scoping in supervisor.js.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-onmsg-'));
const { createTask, amendTask, setTaskStatus, upsertRuntime, getRuntime, getTask } = await import('../src/agents/supervisor/project_memory.js');
const { db } = await import('../src/store.js');
const eventsFor = (tid) => db.prepare('SELECT actor, type, summary FROM pm_events WHERE task_id = ? ORDER BY id').all(tid);

// ---- "new" fit: an operator message STARTS + ACTIVATES a card, pointed at this session ----
// actor is 'operator' (operator-authoritative; pm_events.actor CHECK forbids a custom value) with the
// "from operator message" provenance carried in the summary.
const card = createTask({ projectId: 'p_x', title: 'Add export', goal: 'CSV export on the report page', sessionId: 's_x', actor: 'operator' });
const tid = card.task.id;
assert.ok(tid, 'createTask returns the new id via card.task.id');
assert.equal(card.task.status, 'proposed', 'created as proposed, before activation');
setTaskStatus(tid, 'active', { actor: 'operator', sessionId: 's_x' });
upsertRuntime('s_x', { project_id: 'p_x', active_task_id: tid });
assert.equal(getTask(tid).status, 'active', 'activated');
assert.equal(getRuntime('s_x').active_task_id, tid, 'session runtime points at the new card');
assert.ok(eventsFor(tid).some((e) => e.type === 'opened' && e.actor === 'operator'), 'the create is audited (actor operator)');

// ---- "amend" fit: a later operator message REFINES the same card (goal changes, version bumps) ----
const before = getTask(tid).version;
amendTask(tid, { goal: 'CSV + XLSX export on the report page' }, { actor: 'operator', summary: 'from operator message: broaden export formats' });
assert.equal(getTask(tid).goal, 'CSV + XLSX export on the report page', 'amend updates the goal');
assert.ok(getTask(tid).version > before, 'amend bumps the immutable version');
assert.ok(eventsFor(tid).some((e) => e.type === 'amended' && /from operator message/.test(e.summary || '')), 'amend carries operator-message provenance');

// ---- amend COALESCE: amending one field preserves the other (matches the full-auto call shape) ----
amendTask(tid, { title: 'Add spreadsheet export' }, { actor: 'operator' });
assert.equal(getTask(tid).title, 'Add spreadsheet export', 'title updated');
assert.equal(getTask(tid).goal, 'CSV + XLSX export on the report page', 'goal preserved when only title amended');

// ---- source locks: the wiring + guard scoping the pure chain can't observe ----
const sup = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
assert.ok(sup.includes('const ON_MSG_CARDS = ') && sup.includes('AIOS_SUPERVISOR_ON_MESSAGE'), 'kill-switch present');
assert.ok(sup.includes('BOUNDARY_PROMPT_MS'), 'prompt window present (react within ~a tick, not the long settle)');
assert.ok(/const opGate = ON_MSG_CARDS \? BOUNDARY_PROMPT_MS : settle/.test(sup), 'prompt gate replaces settle ONLY on the operator-message path');
assert.ok(sup.includes('pmCreateTask(') && sup.includes('pmAmendTask('), 'full auto applies create + amend');
assert.ok(sup.includes('from operator message'), 'full-auto mutations carry operator-message provenance in the summary');
// Path 2 (work-derived, no operator message) must remain suggestion-only — never full-auto.
assert.ok(/fromWork: true/.test(sup), 'work-derived detection retained as suggestion-only (guard scoping)');
// Deploy safety: full-auto only acts on messages newer than boot (no backlog reprocessing on restart).
assert.ok(sup.includes('SUPERVISOR_BOOT_TS') && /lastOp > SUPERVISOR_BOOT_TS/.test(sup), 'full-auto is bounded to post-boot operator messages');

console.log('supervisor_on_message: all assertions passed');
