// Lazy migration of legacy supervision docs → task cards (Project Memory phase 6).
// Plan §Phases + round-3 verdicts baked in:
//   - LAZY: fires once per session, only when the operator is actually there (hot tier) and the
//     session runs a legacy doc with no active card. Old docs are already untrustworthy — nothing
//     is migrated eagerly (GPT-5.5 round 3).
//   - PROPOSE, never activate: the converted card lands in status 'proposed' with the ORIGINAL doc
//     archived VERBATIM on the card (full restore possible). The operator activates or declines
//     from the panel banner. One proposal per session, ever (state-keyed).
//   - Trust order for seeding (round-3: "do not trust ## Goal"): `## Now` first, `## Goal` last;
//     only UNCHECKED acceptance criteria carry over (checked ones are history).
//   - Hard rules are CLASSIFIED (one capped fail-open model call), not copied: doctrine candidates
//     (≤3/session, deduped against existing AND rejected rules — a rejected rule is a standing
//     negative), task constraints (ride the card), project facts (surfaced for the operator — the
//     supervisor never writes the builder-owned wiki), fossils/anti-staleness patches (dropped —
//     with the monolith gone there is nothing left for them to fight).

import { db } from '../../store.js';
import { now, id as genId } from '../../util.js';
import { createTask, appendEvent, taskCard } from './project_memory.js';
import { findSimilar } from '../doctrine.js';

// ---- deterministic legacy-doc parsing (no LLM for structure) ------------------------------------
export function parseLegacyDoc(doc) {
  const text = String(doc || '').replace(/\r/g, '');
  const title = (text.match(/^#\s+(.+)$/m) || [])[1]?.trim() || '';
  const section = (name) => {
    const rx = new RegExp(`^##\\s+${name}\\s*$([\\s\\S]*?)(?=^##\\s|\\Z)`, 'im');
    const m = text.match(rx);
    return m ? m[1].trim() : '';
  };
  const bullets = (body) => body.split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').trim()).filter((l) => l && !/^#/.test(l));
  const criteria = [];
  for (const l of section('Acceptance criteria').split('\n')) {
    const m = l.match(/^\s*[-*]\s*\[([ xX])\]\s*(.+)$/);
    if (m && m[1] === ' ') criteria.push(m[2].trim()); // unchecked only — checked criteria are history
  }
  return {
    title,
    now: section('Now').split('\n')[0]?.trim() || '',
    goal: section('Goal').split('\n').map((l) => l.trim()).filter(Boolean).join(' ').slice(0, 1500),
    criteria: criteria.slice(0, 12),
    hardRules: bullets(section('Hard rules')).slice(0, 20),
    verificationNotes: section('Verification notes').slice(0, 800),
  };
}

// ---- hard-rule classification (LLM, injectable, fail-open) ---------------------------------------
export const SYS_MIGRATE = 'You classify lines from a stale per-session supervision document that is being retired. For EACH input line return exactly one bucket: "doctrine" (a durable operator preference/standard that should apply to FUTURE work — generalizable, not tied to this dead task), "constraint" (still-live restriction for the CURRENT task only), "fact" (a descriptive project fact that belongs in project documentation), "fossil" (a product decision that already shipped as code, a dead URL/path, or context for finished work), or "patch" (a negation written to fight the doc\'s own staleness, e.g. "do not treat X as the current goal"). Return STRICT JSON only: {"lines":[{"i":<index>,"bucket":"doctrine|constraint|fact|fossil|patch","rewrite":"<for doctrine only: the rule rewritten as a standing instruction, ≤160 chars>"}]}. Be conservative: prefer fossil over doctrine when in doubt.';

export function buildMigrateUserText(hardRules) {
  return 'LINES:\n' + hardRules.map((r, i) => `${i}: ${r.slice(0, 300)}`).join('\n');
}

export function validateMigrateResult(parsed, hardRules) {
  const out = new Map();
  const BUCKETS = new Set(['doctrine', 'constraint', 'fact', 'fossil', 'patch']);
  for (const l of Array.isArray(parsed?.lines) ? parsed.lines : []) {
    const i = Number(l?.i);
    if (!Number.isInteger(i) || i < 0 || i >= hardRules.length || out.has(i)) continue;
    const bucket = BUCKETS.has(l?.bucket) ? l.bucket : 'fossil';
    out.set(i, { bucket, rewrite: String(l?.rewrite || '').slice(0, 200) });
  }
  return out;
}

// ---- doctrine candidate insertion (capped, dedupe-aware) ------------------------------------------
export function addMigrationDoctrineCandidates({ projectId, sessionId, items, cap = 3 }) {
  let added = 0;
  for (const it of items) {
    if (added >= cap) break;
    const rule = String(it.rewrite || it.text || '').trim();
    if (rule.length < 24) continue;
    const similar = findSimilar({ rule, situation: '' });
    if (similar) continue; // near-dup of an existing rule (or a standing rejected negative) — skip
    db.prepare(`INSERT INTO supervisor_doctrine
      (id, project_id, session_id, decision_id, situation, rule, apply_how, divergence, ask, response, status, source, created_at, updated_at, enforcement, scope)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('doc_' + genId(), projectId, sessionId, null, 'migrated from a legacy supervision doc hard-rule', rule, '', '',
        '', String(it.text || '').slice(0, 400), 'candidate', 'doc-migration', now(), now(), 'advisory', 'project');
    added++;
  }
  return added;
}

// ---- the proposal orchestrator ---------------------------------------------------------------------
// Returns {card, buckets, doctrineAdded} or {skipped}. `call` is injectable for tests.
export async function proposeMigration({ sessionId, projectId, doc, call }) {
  const parsed = parseLegacyDoc(doc);
  if (!parsed.title && !parsed.goal && !parsed.now && !parsed.criteria.length) return { skipped: 'not-a-supervision-doc' };
  // classify hard rules (fail-open: no call / bad JSON → everything archives with the doc)
  let classes = new Map();
  if (parsed.hardRules.length && call) {
    try {
      const raw = await call(SYS_MIGRATE, buildMigrateUserText(parsed.hardRules));
      const m = String(raw || '').match(/\{[\s\S]*\}/);
      classes = validateMigrateResult(m ? JSON.parse(m[0]) : null, parsed.hardRules);
    } catch {}
  }
  const constraints = parsed.hardRules.filter((_, i) => classes.get(i)?.bucket === 'constraint');
  const doctrineItems = parsed.hardRules.map((t, i) => ({ text: t, ...(classes.get(i) || {}) })).filter((x) => x.bucket === 'doctrine');
  const facts = parsed.hardRules.filter((_, i) => classes.get(i)?.bucket === 'fact');
  const dropped = parsed.hardRules.filter((_, i) => ['fossil', 'patch'].includes(classes.get(i)?.bucket || 'fossil'));

  // seed the card: ## Now outranks ## Goal (round-3 trust order); constraints ride as criteria-adjacent notes
  const goal = parsed.now || parsed.goal || parsed.title;
  const card = createTask({
    projectId, sessionId, actor: 'migration', legacyDoc: doc,
    title: parsed.title ? `${parsed.title}`.slice(0, 140) : 'Migrated task',
    goal: [goal, constraints.length ? `Constraints: ${constraints.join(' · ')}`.slice(0, 600) : ''].filter(Boolean).join('\n'),
    criteria: parsed.criteria,
  });
  const doctrineAdded = addMigrationDoctrineCandidates({ projectId, sessionId, items: doctrineItems, cap: 3 });
  appendEvent({
    projectId, taskId: card.task.id, sessionId, actor: 'migration', type: 'legacy_doc',
    summary: `Legacy supervision doc archived verbatim on this card (${doc.length} chars): ${parsed.criteria.length} open criteria carried, ${constraints.length} constraints, ${doctrineAdded} doctrine candidates proposed, ${facts.length} project facts surfaced, ${dropped.length} fossil/anti-staleness lines dropped.`,
    refs: { facts: facts.slice(0, 6).map((f) => f.slice(0, 160)) },
  });
  return { card: taskCard(card.task.id), doctrineAdded, counts: { criteria: parsed.criteria.length, constraints: constraints.length, doctrine: doctrineAdded, facts: facts.length, dropped: dropped.length } };
}
