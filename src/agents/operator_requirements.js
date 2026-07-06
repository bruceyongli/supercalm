import { segmentOperatorMessage } from './supervisor/interpret.js';

const SIDE_BY_SIDE_RX = /\bside[- ]by[- ]side\b/i;
const ALL_UI_RX = /\b(all|every|whole|entire)\b[^.\n]{0,40}\b(ui|page|screen|surface|view)s?\b|\b(ui|page|screen|surface|view)s?\b[^.\n]{0,40}\b(all|every|whole|entire)\b/i;
const CORRECTION_RX = /\b(requested|asked|told|specifically|didn'?t|did not|missed|ignored|failed|claimed|sign[- ]?off|before sign[- ]?off|not captured)\b/i;
const VISUAL_RX = /\b(visual|screenshot|render|layout|style|design|review|qa|polish)\b/i;
const COLUMN_LAYOUT_RX = /\b(column|columns|three[- ]column|left[,/ ]+middle|optional right|layout|devices?)\b/i;
const FIX_DEPLOY_RX = /\b(fix|deploy|go live|ship|prod|production|now)\b/i;
const ADMIN_DEVICES_RX = /\b(admin|devices?|connector|fleet|setup macos|macos device)\b/i;

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
  const add = (s) => {
    const t = oneLine(s, 260);
    if (t && !acceptance.includes(t)) acceptance.push(t);
  };

  for (const m of recent) {
    const text = directRequirementText(m?.text || '');
    if (!text) continue;
    const sideBySide = SIDE_BY_SIDE_RX.test(text);
    const allUi = ALL_UI_RX.test(text);
    const correction = CORRECTION_RX.test(text);
    const columnLayout = COLUMN_LAYOUT_RX.test(text) && (ADMIN_DEVICES_RX.test(text) || /admin\/devices/i.test(text));
    if (sideBySide && (allUi || correction || VISUAL_RX.test(text))) {
      sourceMessages.push({ ts: m.ts || null, text: oneLine(text, 500), kind: 'side_by_side_visual_review' });
      add('Perform a side-by-side visual review across all relevant UI surfaces, not only the example screenshot.');
      add('List every reviewed surface and provide directly inspectable side-by-side artifacts or rendered screenshots for each one.');
      add('Fix every issue found by the side-by-side review, or explicitly document any deferred/not-applicable item with rationale.');
      add('Do not sign off from a single example screenshot, build pass, deployment proof, or prose claim.');
    } else if (columnLayout && (correction || FIX_DEPLOY_RX.test(text) || VISUAL_RX.test(text))) {
      sourceMessages.push({ ts: m.ts || null, text: oneLine(text, 500), kind: 'admin_devices_column_layout' });
      add('Fix the latest operator-reported Admin Devices column/layout issue against the newest screenshot or admin/devices URL, not an older broad design task.');
      add('Verify the rendered production Admin Devices page visually matches the intended left/middle/optional-right structure and does not preserve the operator-rejected column arrangement.');
      add('Treat narrow DOM column counts or prose claims as insufficient when the screenshot still shows the complaint.');
      add('Deploy the corrected Admin Devices layout under the standing deploy policy and provide the production URL/deploy marker plus rendered screenshot evidence.');
    } else if (correction && VISUAL_RX.test(text)) {
      sourceMessages.push({ ts: m.ts || null, text: oneLine(text, 500), kind: 'operator_visual_correction' });
      add('Honor the latest operator visual correction before sign-off, with rendered evidence and a fix/deferral record.');
    }
  }

  if (!sourceMessages.length) return null;
  return {
    kind: 'current_operator_requirements',
    summary: sourceMessages.map((m) => `[${fmtTs(m.ts)}] ${m.text}`).join('\n'),
    source_messages: sourceMessages.slice(0, 6),
    acceptance: acceptance.slice(0, 8),
  };
}

export function formatOperatorRequirements(req = null) {
  if (!req?.acceptance?.length) return '';
  const lines = [
    'CURRENT_OPERATOR_REQUIREMENTS — latest operator-authored requirements/corrections that must be satisfied before sign-off, even if ## Now is stale:',
    ...(req.source_messages || []).slice(0, 4).map((m) => `- operator said: ${m.text}`),
    ...req.acceptance.map((a) => `- gate: ${a}`),
  ];
  return lines.join('\n');
}
