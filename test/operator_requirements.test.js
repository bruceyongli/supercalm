import assert from 'node:assert/strict';
import { currentOperatorRequirements, formatOperatorRequirements } from '../src/agents/operator_requirements.js';

const req = currentOperatorRequirements({
  messages: [
    {
      ts: Date.now(),
      text: "I requested to do a visual side-by-side, and you didn't do it. This is just an example, all UI got issues. You should do all side by side review.",
    },
  ],
});

assert(req, 'operator side-by-side correction should create current requirements');
assert.equal(req.kind, 'current_operator_requirements');
assert(req.acceptance.some((x) => /all relevant UI surfaces/i.test(x)));
assert(req.acceptance.some((x) => /every reviewed surface/i.test(x)));
assert(req.acceptance.some((x) => /single example screenshot/i.test(x)));

const formatted = formatOperatorRequirements(req);
assert.match(formatted, /CURRENT_OPERATOR_REQUIREMENTS/);
assert.match(formatted, /side-by-side visual review across all relevant UI surfaces/i);

assert.equal(currentOperatorRequirements({ messages: [{ ts: Date.now(), text: 'Looks good, thanks.' }] }), null);
assert.equal(
  currentOperatorRequirements({
    messages: [{ ts: Date.now(), text: 'Codex deployed the corrected Admin Devices three-column layout. Live Devices proof ok=true in docs/verify.' }],
  }),
  null,
  'forwarded Codex deployment evidence is not a current operator requirement'
);
assert.equal(
  currentOperatorRequirements({
    messages: [{ ts: Date.now(), text: 'Codex is doing a visual QA/fix pass on Admin Devices after operator screenshot feedback. Please BLOCK if you are editing styles.css now.' }],
  }),
  null,
  'coordination/status reports about Codex are not current operator requirements'
);

const columnReq = currentOperatorRequirements({
  messages: [
    {
      ts: Date.now(),
      text: 'Why did it take so long to fix the column issue for devices? Fix the column and deploy now. https://agent.openhand.ai/admin/devices',
    },
  ],
});

assert(columnReq, 'operator devices column correction should create current requirements');
assert(columnReq.acceptance.some((x) => /Admin Devices column\/layout issue/i.test(x)));
assert(columnReq.acceptance.some((x) => /left\/middle\/optional-right/i.test(x)));
assert(columnReq.acceptance.some((x) => /DOM column counts/i.test(x)));
assert(columnReq.acceptance.some((x) => /Deploy the corrected Admin Devices layout/i.test(x)));

console.log('operator_requirements.test ok');
