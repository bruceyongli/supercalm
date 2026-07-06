// Pillar 4 — self-maintaining, TIME-AWARE supervision doc. Sessions progress: a task finishes and a new
// one begins. The doc therefore carries a MOVING focus (## Now + ## Acceptance criteria = the current task's
// done-bar, which the completion gate reads) and an APPEND-ONLY ## Timeline (the journey: completed work +
// outcomes + how decisions were reached). The maintainer:
//   • folds in new decisions + ticks off met criteria (as before),
//   • ARCHIVES finished work into ## Timeline,
//   • ADVANCES ## Now + ## Acceptance criteria when the work moves to a new task,
//   • (rarely) rewrites ## Goal on an explicit pivot.
// The model returns ONLY a small JSON delta; code MERGES it programmatically (no blind full rewrite). The
// Timeline is never shortened, and supervisor.js keeps a one-step `prevDoc` revert, so history is never lost
// even on a bad advance. Pure + callModel-INJECTED (serves the live supervisor and offline replays/tests).

import { parseJsonObject } from './model.js';

const SYS_DOC_ADVANCE = `You keep a supervision doc CURRENT for ONE autonomous coding-agent session. The doc has a MOVING "## Now" (the current task) + "## Acceptance criteria" (that task's done-bar), persistent "## Goal" / "## Hard rules" / "## Decisions & agreements", and an APPEND-ONLY "## Timeline" (history of completed work + how we got here).

Given the CURRENT DOC and RECENT SIGNALS (the operator's own words/decisions + the agent's progress + the reviewer's own recent verdicts — all NEWER than the doc), decide what to fold in. The key judgment: HAS THE WORK MOVED ON to a new task? Sessions progress — a task finishes and a new one begins (the operator says "now do X" / "go ahead and build Y", or the current criteria are genuinely met). When that happens you MUST advance the focus, not keep gating the finished task.

If RECENT SIGNALS contains CURRENT_OPERATOR_REQUIREMENTS, treat those as mandatory current sign-off gates extracted from the operator's latest words. They are not background. Advance ## Now / ## Acceptance criteria to them when the current doc is broader, narrower, or stale.

Progressive sequencing rule: words like "future", "later", "next phase", "when ready", or "after Goal 1" mean "after prerequisites", not "defer forever", and not a contradiction. Once prerequisite work is accepted, recorded as completed baseline, or no longer a live blocker, the next sequenced/future item becomes valid current work even if nobody repeats the instruction. Do not leave the doc paused on a completed prerequisite or preserve a stale "future" blocker; advance to the next unblocked item.

Return STRICT minified JSON only:
{"new_decisions":["<NEW settled standing decision/agreement not already in the doc>"],"retired_decisions":["<EXACT existing active decision/agreement that only applied to completed/outgoing work and should stop gating future tasks>"],"resolved":[{"item":"<a blocker the doc still presents as active that has been RESOLVED>","why":"<one clause: how>"}],"check_criteria":["<EXACT text of a CURRENT acceptance criterion the signals now establish is MET>"],"completed":[{"task":"<a finished task/milestone, short>","outcome":"<one clause: what was achieved>"}],"advanced":{"now":"<the NEW current task, one line>","acceptance":["<observable done-bar for the new task>"],"reason":"<why: operator directed it / prior task done>"},"goal_update":"<a rewritten Goal — ONLY on an explicit overall PIVOT, else omit>"}

Rules:
- Use empty arrays / omit fields when nothing applies. NEVER invent.
- Be CONSERVATIVE on "advanced": advance when a signal CLEARLY starts a new task, OR the current criteria are clearly met AND either a new direction is named OR the doc/spec already names the next sequenced/future item. If unsure, leave it out — just record decisions/criteria.
- "goal_update" only on explicit pivot language ("new plan is…", "scrap X, do Y instead", "the real goal is now…"). Otherwise omit — advancing Now/criteria covers the normal "next task".
- "new_decisions" is ONLY for standing commitments that should govern future work. Do not put completed-task facts there.
- "retired_decisions" moves old task-specific Decisions out of the active gate. Use it when a Decision was important history but should no longer be demanded after the task advanced.
- "completed" records finished work for the Timeline (history). When you "advanced", also list the OUTGOING task in "completed".
- "advanced.acceptance" items must be OBSERVABLE (a skeptic can mark each true/false from evidence).
- Keep existing Goal/Hard rules unless goal_update. Prefer small, well-evidenced changes.`;

function oneLine(s, max) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function findHeading(lines, rx) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#{1,3}\s+(.+?)\s*$/);
    if (m && rx.test(m[1])) return i;
  }
  return -1;
}
function sectionEnd(lines, headIdx) {
  for (let i = headIdx + 1; i < lines.length; i++) if (/^#{1,3}\s+/.test(lines[i])) return i;
  return lines.length;
}
// Append `bullets` under the heading matching `rx`; create "## <title>" at the end if absent.
function appendUnderSection(lines, rx, title, bullets) {
  if (!bullets.length) return lines;
  const h = findHeading(lines, rx);
  if (h < 0) {
    const out = [...lines];
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(`## ${title}`, ...bullets);
    return out;
  }
  let ins = sectionEnd(lines, h);
  while (ins > h + 1 && lines[ins - 1].trim() === '') ins--; // insert after the section's last real line
  return [...lines.slice(0, ins), ...bullets, ...lines.slice(ins)];
}
// Replace the BODY of a section (keep the heading); create it at the end if absent.
function replaceSection(lines, rx, title, body) {
  const h = findHeading(lines, rx);
  if (h < 0) {
    const out = [...lines];
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(`## ${title}`, ...body, '');
    return out;
  }
  const end = sectionEnd(lines, h);
  const tail = end < lines.length ? ['', ...lines.slice(end)] : lines.slice(end);
  return [...lines.slice(0, h + 1), ...body, ...tail];
}
// The body of a section, flattened to a single "; "-joined string (bullets de-marked) — for archiving the
// outgoing focus and for de-duping the Timeline.
function sectionBody(lines, rx) {
  const h = findHeading(lines, rx);
  if (h < 0) return '';
  return lines
    .slice(h + 1, sectionEnd(lines, h))
    .map((l) => l.replace(/^\s*[-*]\s*(?:\[[ xX]\]\s*)?/, '').trim())
    .filter(Boolean)
    .join('; ');
}

function normText(s) {
  return oneLine(s, 240).toLowerCase();
}

function bulletBody(line) {
  return String(line || '').replace(/^\s*[-*]\s*(?:\[[ xX]\]\s*)?/, '').trim();
}

function removeBulletsUnderSection(lines, rx, needles) {
  const wants = needles.map(normText).filter((s) => s.length > 6);
  if (!wants.length) return { lines, removed: [] };
  const h = findHeading(lines, rx);
  if (h < 0) return { lines, removed: [] };
  const end = sectionEnd(lines, h);
  const removed = [];
  const next = [...lines.slice(0, h + 1)];
  for (const line of lines.slice(h + 1, end)) {
    const body = bulletBody(line);
    const bn = normText(body);
    const hit = body && wants.some((w) => bn.includes(w) || w.includes(bn));
    if (hit) {
      removed.push(body);
    } else {
      next.push(line);
    }
  }
  return { lines: [...next, ...lines.slice(end)], removed };
}

// Append one bullet under a doc STRING's "## Decisions & agreements" (created if absent) and return the new
// doc. Reused by the supervisor's Resolve action and the Council commit to record an operator/council
// decision into the living doc so the supervisor steers by it. `tag` (e.g. "operator", "council") + an
// ISO-ish date are folded in for provenance.
export function appendDecisionLine(doc, text, { tag = 'operator', date = '' } = {}) {
  const t = oneLine(text, 400);
  if (!t) return doc;
  const stamp = [tag, date].filter(Boolean).join(' ');
  const bullet = `- ${t}${stamp ? ` _(${stamp})_` : ''}`;
  const lines = String(doc || '').replace(/\r/g, '').split('\n');
  return appendUnderSection(lines, /^decisions?\b/i, 'Decisions & agreements', [bullet]).join('\n');
}

// Returns { changed, doc?, summary?, error? }. `now` (ms) stamps Timeline entries with a date.
export async function maintainDoc({ callModel, doc, signalsText, now = 0, maxItems = 8 }) {
  if (!doc || !doc.trim() || !signalsText) return { changed: false };
  let parsed;
  try {
    const r = await callModel(
      [
        { role: 'system', content: SYS_DOC_ADVANCE },
        { role: 'user', content: 'CURRENT DOC:\n' + doc + '\n\n' + signalsText + '\n\nReturn JSON only.' },
      ],
      { json: true, temperature: 0, maxTokens: 2400 }
    );
    parsed = parseJsonObject(r?.content);
  } catch (e) {
    return { changed: false, error: String(e.message || e).slice(0, 140) };
  }
  if (!parsed) return { changed: false, error: 'unparsed delta' };

  const arr = (v) => (Array.isArray(v) ? v : []);
  const norm = normText;
  const has = (hay, needle) => needle.length > 6 && hay.includes(norm(needle));
  const docLower = doc.toLowerCase();

  const decisions = arr(parsed.new_decisions).map((s) => oneLine(s, 220)).filter((s) => s && !has(docLower, s)).slice(0, maxItems);
  const retiredDecisions = arr(parsed.retired_decisions).map((s) => oneLine(s, 220)).filter(Boolean).slice(0, maxItems);
  const resolved = arr(parsed.resolved).filter((x) => x && x.item).map((x) => ({ item: oneLine(x.item, 160), why: oneLine(x.why, 160) })).filter((r) => !has(docLower, r.item)).slice(0, maxItems);
  const checks = arr(parsed.check_criteria).map((s) => oneLine(s, 220)).filter(Boolean).slice(0, maxItems);
  const completed = arr(parsed.completed).filter((x) => x && x.task).map((x) => ({ task: oneLine(x.task, 160), outcome: oneLine(x.outcome, 200) })).slice(0, maxItems);
  const adv =
    parsed.advanced && parsed.advanced.now && Array.isArray(parsed.advanced.acceptance) && parsed.advanced.acceptance.length
      ? { now: oneLine(parsed.advanced.now, 200), acceptance: parsed.advanced.acceptance.map((s) => oneLine(s, 200)).filter(Boolean).slice(0, 12), reason: oneLine(parsed.advanced.reason || '', 160) }
      : null;
  const goalUpdate = typeof parsed.goal_update === 'string' && parsed.goal_update.trim().length > 12 ? parsed.goal_update.trim().slice(0, 1200) : null;

  let lines = doc.replace(/\r/g, '').split('\n');

  // 1. tick off met criteria (in place)
  let nChk = 0;
  for (const c of checks) {
    const cn = norm(c);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*-\s*)\[ \]\s*(.+)$/);
      if (m && (norm(m[2]).includes(cn) || cn.includes(norm(m[2])))) {
        lines[i] = `${m[1]}[x] ${m[2]}`;
        nChk++;
        break;
      }
    }
  }

  // 2. archive finished work + (when advancing) the outgoing focus into ## Timeline (append-only, deduped)
  const stamp = now ? new Date(now).toISOString().slice(0, 10) + ': ' : '';
  const seenTimeline = sectionBody(lines, /^timeline$|timeline|journey|history|progress log/i).toLowerCase();
  const tlBullets = [];
  const pushTl = (text) => {
    const t = oneLine(text, 240);
    if (t && !seenTimeline.includes(norm(t).slice(0, 40)) && !tlBullets.some((b) => b.toLowerCase().includes(norm(t).slice(0, 40)))) tlBullets.push(`- ${stamp}${t}`);
  };
  // archive the OUTGOING focus when advancing — but only the VERBATIM ## Now as a fallback when the model
  // didn't summarize the finished work itself (the `completed` items below are cleaner). This avoids a
  // double/truncated Timeline entry while guaranteeing the finished task is never silently dropped.
  if (adv && !completed.length) {
    const outgoing = sectionBody(lines, /^now$/i) || oneLine(sectionBody(lines, /acceptance|criteria|definition of done|^done$/i), 200) || '(previous task)';
    pushTl(`${outgoing}${adv.reason ? ' — ' + adv.reason : ' — completed'}`);
  }
  for (const c of completed) pushTl(`${c.task}${c.outcome ? ' — ' + c.outcome : ''}`);
  if (tlBullets.length) lines = appendUnderSection(lines, /^timeline$|timeline|journey|history|progress log/i, 'Timeline', tlBullets);

  // 3. advance the focus: replace ## Now + ## Acceptance criteria with the new task's
  if (adv) {
    lines = replaceSection(lines, /^now$/i, 'Now', [adv.now]);
    lines = replaceSection(lines, /acceptance|criteria|definition of done|^done$/i, 'Acceptance criteria', adv.acceptance.map((a) => `- [ ] ${a}`));
  }

  // 4. goal pivot (rare, hardest-gated)
  if (goalUpdate) lines = replaceSection(lines, /^goal$/i, 'Goal', [goalUpdate]);

  // 5. append decisions + resolved blockers (as before)
  let archivedDecisionBullets = [];
  if (retiredDecisions.length) {
    const r = removeBulletsUnderSection(lines, /decision|agreement|agreed/i, retiredDecisions);
    lines = r.lines;
    archivedDecisionBullets = r.removed.map((d) => `- ${stamp}${d} — archived; no longer an active gate`);
  }
  const decBullets = decisions.map((d) => `- ${d}`);
  const resBullets = resolved.map((r) => `- ${r.item} — resolved${r.why ? ': ' + r.why : ''}`);
  if (decBullets.length) lines = appendUnderSection(lines, /decision|agreement|agreed/i, 'Decisions & agreements', decBullets);
  if (archivedDecisionBullets.length) lines = appendUnderSection(lines, /^archived context$|^historical context$/i, 'Archived context', archivedDecisionBullets);
  if (resBullets.length) lines = appendUnderSection(lines, /^resolved$|resolved/i, 'Resolved', resBullets);

  const changed = nChk + decBullets.length + archivedDecisionBullets.length + resBullets.length + tlBullets.length + (adv ? 1 : 0) + (goalUpdate ? 1 : 0) > 0;
  if (!changed) return { changed: false };
  const summary = [adv ? 'advanced focus' : '', tlBullets.length ? `+${tlBullets.length} timeline` : '', decBullets.length ? `+${decBullets.length} decisions` : '', archivedDecisionBullets.length ? `${archivedDecisionBullets.length} decisions archived` : '', resBullets.length ? `+${resBullets.length} resolved` : '', nChk ? `${nChk} criteria checked` : '', goalUpdate ? 'goal updated' : ''].filter(Boolean).join(', ');
  return { changed: true, doc: lines.join('\n'), summary };
}
