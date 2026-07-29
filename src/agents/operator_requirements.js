import { createHash } from 'node:crypto';
import { segmentOperatorMessage } from './supervisor/interpret.js';

const SIDE_BY_SIDE_RX = /\bside[- ]by[- ]side\b/i;
const ALL_UI_RX = /\b(all|every|whole|entire)\b[^.\n]{0,40}\b(ui|page|screen|surface|view)s?\b|\b(ui|page|screen|surface|view)s?\b[^.\n]{0,40}\b(all|every|whole|entire)\b/i;
const CORRECTION_RX = /\b(requested|asked|told|specifically|didn'?t|did not|missed|ignored|failed|claimed|sign[- ]?off|before sign[- ]?off|not captured)\b/i;
const VISUAL_RX = /\b(visual|screenshot|render|layout|style|design|review|qa|polish)\b/i;
const COLUMN_LAYOUT_RX = /\b(column|columns|three[- ]column|left[,/ ]+middle|optional right|layout|devices?)\b/i;
const FIX_DEPLOY_RX = /\b(fix|deploy|go live|ship|prod|production|now)\b/i;
const ADMIN_DEVICES_RX = /\b(admin|devices?|connector|fleet|setup macos|macos device)\b/i;
const REQUIREMENT_DIRECTIVE_RX = /\b(?:before sign[- ]?off|must|required|requirement|please|i (?:need|want|expect|asked|requested)|you (?:must|should|need to)|make sure|ensure|do not|don'?t|never)\b|^\s*(?:create|show|provide|run|fix|test|verify|deploy|keep|use|add|remove|update|document|list)\b/i;
const ACTION_START_RX = /^(?:create|show|provide|run|fix|test|verify|deploy|keep|use|add|remove|update|document|list|perform|honor|treat|do not|don'?t|never)\b/i;

function oneLine(s, max = 260) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function fmtTs(ts) {
  try {
    return new Date(Number(ts)).toISOString();
  } catch {
    return '';
  }
}

function directRequirementText(text) {
  const segments = segmentOperatorMessage(text);
  if (!segments.length) return '';
  const direct = segments.filter((seg) => seg.label !== 'forwarded_report').map((seg) => seg.text || '').filter(Boolean);
  return direct.join('\n');
}

function requirementDirectives(text) {
  return segmentOperatorMessage(text)
    .filter((seg) => {
      if (seg.label === 'operator_directive') {
        return !['question_only', 'status_question', 'wait', 'ack'].includes(seg.intent);
      }
      return seg.label === 'commentary' && !/[?]/.test(seg.text || '') && REQUIREMENT_DIRECTIVE_RX.test(seg.text || '');
    })
    .map((seg) => seg.text || '')
    .filter(Boolean);
}

function clauseId(text) {
  return 'opreq_' + createHash('sha256').update(String(text || '').toLowerCase()).digest('hex').slice(0, 12);
}

function cleanClause(text) {
  return oneLine(String(text || '')
    .replace(/^[,;:\s]+/, '')
    .replace(/[,;:\s.]+$/, ''), 260);
}

function splitActionList(text) {
  const cleaned = cleanClause(String(text || '')
    .replace(/^(?:before sign[- ]?off|before completion|for sign[- ]?off)\s*,?\s*(?:also\s+)?/i, ''));
  if (!cleaned) return [];

  const commaParts = cleaned.split(/\s*,\s*/);
  if (commaParts.length >= 2) {
    const last = commaParts.pop().replace(/^and\s+/i, '');
    const parts = [...commaParts, last].map(cleanClause).filter(Boolean);
    if (parts.length >= 2 && parts.every((part) => ACTION_START_RX.test(part))) return parts;
  }

  const andParts = cleaned.split(/\s+\band\b\s+/i).map(cleanClause).filter(Boolean);
  if (andParts.length === 2 && andParts.every((part) => ACTION_START_RX.test(part))) return andParts;
  return [cleaned];
}

export function atomicRequirementClauses(text) {
  const clauses = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const withoutMarker = line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '');
    for (const clause of splitActionList(withoutMarker)) {
      if (!REQUIREMENT_DIRECTIVE_RX.test(clause) && !ACTION_START_RX.test(clause)) continue;
      const item = { id: clauseId(clause), text: clause };
      if (!clauses.some((existing) => existing.id === item.id)) clauses.push(item);
    }
  }
  return clauses;
}

export function currentOperatorRequirements(signals = {}, { now = Date.now(), windowMs = 12 * 60 * 60 * 1000 } = {}) {
  const messages = Array.isArray(signals?.messages) ? signals.messages : [];
  const recent = messages
    .filter((m) => {
      const ts = Number(m?.ts || 0);
      return !ts || now - ts <= windowMs;
    })
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));

  const sourceMessages = [];
  const acceptance = [];
  const clauses = [];
  const add = (s, source = null) => {
    const t = oneLine(s, 260);
    if (!t || acceptance.includes(t)) return;
    acceptance.push(t);
    clauses.push({
      id: clauseId(t),
      text: t,
      source_ts: source?.ts || null,
      source_kind: source?.kind || 'operator_requirement',
    });
  };

  for (const m of recent) {
    const text = directRequirementText(m?.text || '');
    if (!text) continue;
    const sideBySide = SIDE_BY_SIDE_RX.test(text);
    const allUi = ALL_UI_RX.test(text);
    const correction = CORRECTION_RX.test(text);
    const columnLayout = COLUMN_LAYOUT_RX.test(text) && (ADMIN_DEVICES_RX.test(text) || /admin\/devices/i.test(text));
    if (sideBySide && (allUi || correction || VISUAL_RX.test(text))) {
      const source = { ts: m.ts || null, text: oneLine(text, 500), kind: 'side_by_side_visual_review' };
      sourceMessages.push(source);
      add('Perform a side-by-side visual review across all relevant UI surfaces, not only the example screenshot.', source);
      add('List every reviewed surface and provide directly inspectable side-by-side artifacts or rendered screenshots for each one.', source);
      add('Fix every issue found by the side-by-side review, or explicitly document any deferred/not-applicable item with rationale.', source);
      add('Do not sign off from a single example screenshot, build pass, deployment proof, or prose claim.', source);
    } else if (columnLayout && (correction || FIX_DEPLOY_RX.test(text) || VISUAL_RX.test(text))) {
      const source = { ts: m.ts || null, text: oneLine(text, 500), kind: 'admin_devices_column_layout' };
      sourceMessages.push(source);
      add('Fix the latest operator-reported Admin Devices column/layout issue against the newest screenshot or admin/devices URL, not an older broad design task.', source);
      add('Verify the rendered production Admin Devices page visually matches the intended left/middle/optional-right structure and does not preserve the operator-rejected column arrangement.', source);
      add('Treat narrow DOM column counts or prose claims as insufficient when the screenshot still shows the complaint.', source);
      add('Deploy the corrected Admin Devices layout under the standing deploy policy and provide the production URL/deploy marker plus rendered screenshot evidence.', source);
    } else if (correction && VISUAL_RX.test(text)) {
      const source = { ts: m.ts || null, text: oneLine(text, 500), kind: 'operator_visual_correction' };
      sourceMessages.push(source);
      add('Honor the latest operator visual correction before sign-off, with rendered evidence and a fix/deferral record.', source);
    } else {
      const directClauses = requirementDirectives(m?.text || '')
        .filter((directive) => REQUIREMENT_DIRECTIVE_RX.test(directive))
        .flatMap((directive) => atomicRequirementClauses(directive));
      if (!directClauses.length) continue;
      const source = { ts: m.ts || null, text: oneLine(directClauses.map((clause) => clause.text).join('; '), 500), kind: 'atomic_operator_requirements' };
      sourceMessages.push(source);
      for (const clause of directClauses) add(clause.text, source);
    }
  }

  if (!sourceMessages.length) return null;
  return {
    kind: 'current_operator_requirements',
    summary: sourceMessages.map((m) => `[${fmtTs(m.ts)}] ${m.text}`).join('\n'),
    source_messages: sourceMessages.slice(0, 6),
    acceptance: acceptance.slice(0, 16),
    clauses: clauses.slice(0, 16),
  };
}

export function formatOperatorRequirements(req = null) {
  if (!req?.acceptance?.length) return '';
  const lines = [
    'CURRENT_OPERATOR_REQUIREMENTS — latest operator-authored requirements/corrections that must be satisfied before sign-off, even if ## Now is stale:',
    ...(req.source_messages || []).slice(0, 4).map((m) => `- operator said: ${m.text}`),
    ...(req.clauses?.length
      ? req.clauses.map((clause) => `- gate ${clause.id}: ${clause.text}`)
      : req.acceptance.map((a) => `- gate: ${a}`)),
  ];
  return lines.join('\n');
}
