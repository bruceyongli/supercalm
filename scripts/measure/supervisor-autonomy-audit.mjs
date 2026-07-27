#!/usr/bin/env node
// Model-free conformance audit for docs/supervisor-mission-and-autonomy.md.
//
// This is intentionally a MEASUREMENT, not a production policy shim. It exercises current pure
// policy/code seams and reports where implementation still differs from the operator-defined
// Co-pilot/Autopilot contract. --strict turns any unmet requirement into a nonzero exit.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideSupervisorAction } from '../../src/agents/supervisor/decide.js';
import { sendPolicy } from '../../src/agents/supervisor/send_policy.js';
import { emptyKernelState, evaluateSend } from '../../src/agents/send_kernel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const strict = process.argv.includes('--strict');
const checks = [];

function check(mode, area, expectation, observed, pass, evidence = '') {
  checks.push({ mode, area, expectation, observed, pass: !!pass, evidence });
}

function policy(mode, kind, meta = {}) {
  return sendPolicy(mode, kind, meta);
}

// Co-pilot: active review, conservative management.
check('Co-pilot', 'Evidence', 'send evidence challenges', policy('copilot', 'challenge').allowed, policy('copilot', 'challenge').allowed);
check('Co-pilot', 'Routine answer', 'send only confident, explicitly non-reserved answers',
  policy('copilot', 'answer', { confidence: 0.9, reserved: false }).allowed,
  policy('copilot', 'answer', { confidence: 0.9, reserved: false }).allowed);
check('Co-pilot', 'Uncertain answer', 'hold an uncertain answer',
  policy('copilot', 'answer', { confidence: 0.6, reserved: false }).reason,
  !policy('copilot', 'answer', { confidence: 0.6, reserved: false }).allowed);
check('Co-pilot', 'Keep-working', 'draft/hold autonomous nudges',
  policy('copilot', 'nudge').reason,
  !policy('copilot', 'nudge').allowed);
check('Co-pilot', 'Recovery', 'draft/hold state-changing recovery',
  policy('copilot', 'recover').reason,
  !policy('copilot', 'recover').allowed);
const reservedProposal = {
  kind: 'answer',
  text: 'run bin/deploy now',
  paneSig: 'audit-pane',
  intentName: 'ANSWER_QUESTION',
};
const reserved = evaluateSend(emptyKernelState(), reservedProposal, 1785170000000);
check('Co-pilot', 'Reserved action', 'fail closed without explicit scoped authority',
  reserved.reason,
  !reserved.allowed && reserved.reason === 'kernel-reserved:deploy');

// Autopilot: current send authority.
for (const kind of ['answer', 'challenge', 'nudge', 'recover']) {
  const got = policy('autopilot', kind, { confidence: 0, reserved: true });
  check('Autopilot', `Send ${kind}`, `may send ${kind} after upstream policy gates`, got.allowed, got.allowed);
}

const planSnapshot = {
  generatedAt: 1785170000000,
  stance: 'normal',
  session: {
    id: 's_audit',
    status: 'waiting',
    category: 'decision',
    stage: 'awaiting_approval',
    summary: 'Plan is complete and submitted for approval',
    updatedAt: 1785170000000,
  },
  supervisionDoc: { raw: '# Goal\nShip the verified change', gateScopeKey: 'audit' },
  operator: { intent: 'none', lastMessageText: '', lastMessageTs: null },
  supervisorState: {},
  agent: {},
};
const modeOnlyPlan = decideSupervisorAction(planSnapshot, { mode: 'autopilot' });
check('Autopilot', 'Plan ownership',
  'selecting Supervisor Autopilot is sufficient for the Supervisor to review the submitted plan',
  `${modeOnlyPlan.ruleId}/${modeOnlyPlan.action.type}`,
  modeOnlyPlan.action.type === 'answer',
  'decideSupervisorAction currently receives but does not use config.mode for plan authority');

const stancePlan = decideSupervisorAction({ ...planSnapshot, stance: 'autopilot' }, { mode: 'autopilot' });
check('Autopilot', 'Plan quality',
  'review/correct/accept the plan rather than blindly telling the builder to proceed',
  `${stancePlan.ruleId}/${stancePlan.action.type}`,
  stancePlan.action.type === 'answer',
  'a submitted plan needs the answer/review brain; a generic nudge cannot inspect plan quality');

const hold = decideSupervisorAction({ ...planSnapshot, stance: 'hold' }, { mode: 'autopilot' });
check('Autopilot', 'Operator stop/hold',
  'an explicit hold overrides Autopilot',
  `${hold.ruleId}/${hold.action.type}`,
  hold.ruleId === 'operator.hold' && hold.action.type === 'wait');

const exit = decideSupervisorAction({
  ...planSnapshot,
  stance: 'normal',
  session: { ...planSnapshot.session, status: 'exited', category: 'working', exitCode: 1 },
  supervisorState: { signedOff: false, recoveryState: { exit: { resolved: false } } },
}, { mode: 'autopilot', allowExitRecovery: true });
check('Autopilot', 'Unexpected exit',
  'recover an unfinished supervised session through the bounded recovery path',
  `${exit.ruleId}/${exit.action.type}`,
  exit.ruleId === 'recover.unexpected_exit' && exit.action.type === 'recover' && exit.allowedSend);

const answerPrompt = readFileSync(join(ROOT, 'src/agents/answer_prompt.js'), 'utf8');
const supervisorSource = readFileSync(join(ROOT, 'src/agents/supervisor.js'), 'utf8');
const orchestratorSource = readFileSync(join(ROOT, 'src/deploy_orchestrator.js'), 'utf8');
const publisherSource = readFileSync(join(ROOT, 'src/publisher.js'), 'utf8');

const ownsCardsInternally =
  /task card closed — all criteria satisfied and gate-verified/.test(supervisorSource) &&
  /started a new task card from your message/.test(supervisorSource);
check('Autopilot', 'Task lifecycle',
  'maintain this session task contract from task creation through verified close',
  ownsCardsInternally ? 'internal create + verified-close paths present' : 'complete internal lifecycle not found',
  ownsCardsInternally,
  'outbound card directives remain blocked, which preserves cross-session scope');

const agentFiles = execFileSync('rg', ['--files', 'src/agents'], { cwd: ROOT, encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);
const integrationActuator = agentFiles.some((file) => {
  const source = readFileSync(join(ROOT, file), 'utf8');
  return /\/api\/session\/:id\/integrate|enqueue\s*\(|requestSessionIntegration\s*\(|requestIntegration\s*\(/.test(source);
});
check('Autopilot', 'Integration actuator',
  'submit the exact verified candidate to the prescribed integration pipeline',
  integrationActuator ? 'Supervisor integration actuator found' : 'no Supervisor integration actuator',
  integrationActuator,
  'the HTTP trigger exists outside the agent framework, but the Supervisor cannot invoke it');

const standingDeployRejected =
  /general "deployment is authorized"[\s\S]{0,180}NOT a blanket pre-approval/.test(answerPrompt) ||
  /general "deployment is authorized"[\s\S]{0,180}not a blanket pre-approval/i.test(answerPrompt);
check('Autopilot', 'Standing deployment delegation',
  'honor an operator-enabled standing deploy mechanism without a per-release prompt',
  standingDeployRejected ? 'prompt rejects standing delegation' : 'standing delegation recognized',
  !standingDeployRejected,
  'direct deploy text should stay blocked; the desired path is a gated Supervisor integration actuator');

const gatePresent =
  /publishOn\(q\.project_id\)/.test(orchestratorSource) &&
  /isolation\(q\.project_id\)/.test(orchestratorSource) &&
  /blocks\(q\.project_id/.test(orchestratorSource) &&
  /gate\(q\.id/.test(orchestratorSource);
check('Autopilot', 'Release hard gates',
  'require deployment enablement, isolation, breaker, and deterministic gate before publication',
  gatePresent ? 'all orchestrator pre-publication gates present' : 'one or more gates absent',
  gatePresent);

const servedVerification =
  /servedHasCandidate|servedSha/.test(publisherSource) &&
  /VERIFYING/.test(publisherSource) &&
  /GREEN/.test(publisherSource) &&
  /ROLLING_BACK|startRollback/.test(publisherSource);
check('Autopilot', 'Post-release proof',
  'verify served identity/health and retain a rollback path',
  servedVerification ? 'served verification + rollback path present' : 'post-release proof path incomplete',
  servedVerification);

const releaseMonitoring =
  /maybeMonitorIntegration\(ctx, cfg, st\)/.test(supervisorSource) &&
  /row\.stage === 'GREEN'/.test(supervisorSource) &&
  /row\.stage === 'HELD'/.test(supervisorSource) &&
  /row\.stage === 'REJECTED' \|\| row\.stage === 'ROLLED_BACK'/.test(supervisorSource);
check('Autopilot', 'Release ownership',
  'monitor the durable release through GREEN, repair a safe failure, and hold an ambiguous publication',
  releaseMonitoring ? 'GREEN/failure/HELD monitoring wired' : 'durable release monitoring incomplete',
  releaseMonitoring);

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const totals = {};
for (const mode of ['Co-pilot', 'Autopilot']) {
  const rows = checks.filter((c) => c.mode === mode);
  totals[mode] = { passed: rows.filter((c) => c.pass).length, total: rows.length };
}
const releaseReady = checks.every((c) => c.pass);
const result = {
  schema: 'supervisor.autonomy.audit/v1',
  at: new Date().toISOString(),
  candidate: sha,
  version,
  releaseReady,
  totals,
  checks,
};

const reportDir = join(ROOT, 'data', 'supervisor-autonomy');
mkdirSync(reportDir, { recursive: true });
const stamp = result.at.replace(/[:.]/g, '-');
const jsonPath = join(reportDir, `audit-${stamp}.json`);
const mdPath = join(reportDir, `audit-${stamp}.md`);
writeFileSync(jsonPath, JSON.stringify(result, null, 2) + '\n');
writeFileSync(mdPath, [
  `# Supervisor autonomy audit — ${result.at}`,
  '',
  `- Candidate: \`${sha}\``,
  `- Package: \`${version}\``,
  `- Verdict: **${releaseReady ? 'RELEASE-CONDITION MET' : 'RELEASE-CONDITION NOT MET'}**`,
  `- Co-pilot: ${totals['Co-pilot'].passed}/${totals['Co-pilot'].total}`,
  `- Autopilot: ${totals.Autopilot.passed}/${totals.Autopilot.total}`,
  '',
  '| Mode | Area | Result | Observed |',
  '|---|---|---:|---|',
  ...checks.map((c) => `| ${c.mode} | ${c.area} | ${c.pass ? 'PASS' : 'FAIL'} | ${String(c.observed).replace(/\|/g, '\\|')} |`),
  '',
].join('\n'));

console.log(`Supervisor autonomy audit · v${version} · ${sha}`);
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.mode} · ${c.area} — ${c.observed}`);
console.log(`Co-pilot ${totals['Co-pilot'].passed}/${totals['Co-pilot'].total}`);
console.log(`Autopilot ${totals.Autopilot.passed}/${totals.Autopilot.total}`);
console.log(`Verdict: ${releaseReady ? 'RELEASE-CONDITION MET' : 'RELEASE-CONDITION NOT MET'}`);
console.log(`Report: ${mdPath}`);
console.log(`JSON: ${jsonPath}`);

if (strict && !releaseReady) process.exit(2);
