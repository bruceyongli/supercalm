// Autonomous integrate-&-deploy — the DETERMINISTIC GATE (docs/specs/autonomous-deploy-plan.md step 3).
// Given a QUEUED integration, prepare an isolated worktree of the candidate REBASED onto latest main (the
// green baseline), run the deterministic checks (build/tests + secret scan) + a PROTECTED-PATH sentinel, and
// mark it APPROVED (ready to publish) or REJECTED — the multi-agent-safe gate that replaces the human,
// BEFORE any AI reviewers (step 7). "Safe before smart."
//
// This module ONLY produces a gated verdict. Driving APPROVED → GREEN (merge to main + restart-surviving
// health verify) is the next sub-step, behind the operator's integrate capability — auto-deploying the live
// service is the highest-risk action, so it ships after the gate is proven.
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { gitOut } from './git.js';
import { defaultBranch, worktreeRoot, sanitize } from './worktrees.js';
import * as I from './integrations.js';
import * as store from './store.js';
import { flagOn } from './flags.js';
import { reviewCandidate } from './deploy_reviewers.js';

const exec = promisify(execFile);

// PROTECTED PATHS — a candidate that touches any of these is INELIGIBLE for autonomous deploy: they can
// subvert the deploy path, the DB schema, or the CHECK HARNESS ITSELF (the anti-gaming rule: the gate can't
// be relaxed by the very change under review). Such a candidate is REJECTED → needs stronger/human review.
const PROTECTED = [
  /^bin\/(deploy|release|version|integrate|update|install-service)/,
  /^scripts\/(scan-secrets|aios-git-guardrail)/,
  /^src\/(integrations|integrator|config|store)\.js$/, // the machine, config, + DB open/schema
  /^src\/worktrees\.js$/,
  /^src\/server\.js$/,                                  // the router + boot + health endpoints
  /\.plist$/, /supercalm\.service$/,                   // launchd / systemd units
  /^package(-lock)?\.json$/,                            // deps + the test-harness definition
  /^\.github\//,                                        // CI
  /^test\//,                                            // the tests that gate everything
];

const short = (s, n = 400) => String(s || '').slice(-n);
const digest = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);

// Create a throwaway worktree of the candidate, REBASED onto latest `base`. Returns { path, sha } on success,
// { conflict, detail } if the rebase conflicts (candidate isn't autonomously mergeable → kick to a human),
// or { error } on a setup failure. Failure-atomic: a half-made worktree is force-removed.
async function prepareCandidate(repoPath, candidateSha, base) {
  const path = join(worktreeRoot(), '_gate', sanitize(candidateSha).slice(0, 16) + '-' + Date.now().toString(36));
  const add = await gitOut(repoPath, ['worktree', 'add', '--detach', path, candidateSha], { timeout: 30000 });
  if (add.error || !existsSync(path)) { await gitOut(repoPath, ['worktree', 'remove', '--force', path]).catch(() => {}); return { error: 'worktree add failed: ' + short(add.error) }; }
  const reb = await gitOut(path, ['rebase', base], { timeout: 60000 });
  if (reb.error) {
    await gitOut(path, ['rebase', '--abort']).catch(() => {});
    await gitOut(repoPath, ['worktree', 'remove', '--force', path]).catch(() => {});
    return { conflict: true, detail: short(reb.error, 300) };
  }
  const sha = (await gitOut(path, ['rev-parse', 'HEAD'])).text.trim();
  return { path, sha };
}

// Deterministic checks on the rebased worktree. Each is bounded + fail-soft. Returns { pass, checks[] }.
async function runChecks(worktreePath, { testCmd } = {}) {
  const checks = [];
  const run = async (name, cmd, args, timeout) => {
    try { await exec(cmd, args, { cwd: worktreePath, timeout: timeout || 600000, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' }); checks.push({ name, ok: true }); return true; }
    catch (e) { checks.push({ name, ok: false, detail: short(e.stderr || e.message || e) }); return false; }
  };
  // Secret scan — best-effort; only if the candidate carries the scanner (AIOS's own projects do).
  if (existsSync(join(worktreePath, 'scripts', 'scan-secrets.mjs'))) await run('secret-scan', 'node', ['scripts/scan-secrets.mjs'], 60000);
  // Build/tests — the configured command, else `npm test` if package.json declares one, else a hard fail
  // (a candidate with no way to prove itself must NOT auto-deploy).
  let cmd = testCmd;
  if (!cmd) { try { cmd = JSON.parse(readFileSync(join(worktreePath, 'package.json'), 'utf8')).scripts?.test ? 'npm test' : null; } catch { cmd = null; } }
  if (cmd) await run('tests', 'bash', ['-lc', cmd], 900000);
  else checks.push({ name: 'tests', ok: false, detail: 'no test command configured — cannot verify' });
  return { pass: checks.every((c) => c.ok), checks };
}

// Drive a QUEUED integration through the deterministic gate → APPROVED or REJECTED (or HELD on a setup
// error). Every step is a fenced state-machine transition; the checks_digest binds the verdict to the exact
// rebased SHA + inputs. Returns the final integration row.
export async function driveGate(integrationId, { fenceToken, testCmd, review } = {}) {
  const it = I.getIntegration(integrationId);
  if (!it) throw new Error('no such integration: ' + integrationId);
  const ft = fenceToken ?? it.fence_token;
  const project = it.project_id ? store.getProject(it.project_id) : null;
  const repoPath = project?.path;
  const candidate = it.candidate_sha || it.source_sha;
  if (!repoPath || !existsSync(repoPath) || !candidate) {
    return I.transition(integrationId, 'REJECTED', { fenceToken: ft, patch: { failure_code: 'no_repo_or_candidate' }, data: { repoPath, candidate } });
  }

  I.transition(integrationId, 'PREPARING', { fenceToken: ft }); // claims the pipeline (single-active enforced)
  const base = await defaultBranch(repoPath);
  const prep = await prepareCandidate(repoPath, candidate, base);
  if (prep.error) return I.transition(integrationId, 'HELD', { fenceToken: ft, patch: { failure_code: 'prepare_error' }, data: { detail: prep.error } });
  if (prep.conflict) return I.transition(integrationId, 'REJECTED', { fenceToken: ft, patch: { failure_code: 'rebase_conflict' }, data: { detail: prep.detail } });

  const files = (await gitOut(repoPath, ['diff', '--name-only', `${base}..${prep.sha}`])).text.split('\n').filter(Boolean);
  const protectedHits = files.filter((f) => PROTECTED.some((rx) => rx.test(f)));

  I.transition(integrationId, 'CHECKING', { fenceToken: ft, patch: { candidate_sha: prep.sha, base_sha: (await gitOut(repoPath, ['rev-parse', base])).text.trim() } });
  const checks = protectedHits.length ? { pass: false, checks: [] } : await runChecks(prep.path, { testCmd });
  const dg = digest({ sha: prep.sha, base, files, checks: checks.checks, protectedHits });
  await gitOut(repoPath, ['worktree', 'remove', '--force', prep.path]).catch(() => {}); // clean up the gate worktree

  if (protectedHits.length) return I.transition(integrationId, 'REJECTED', { fenceToken: ft, patch: { checks_digest: dg, failure_code: 'protected_path' }, data: { protectedHits } });
  if (!checks.pass) return I.transition(integrationId, 'REJECTED', { fenceToken: ft, patch: { checks_digest: dg, failure_code: 'checks_failed' }, data: { checks: checks.checks } });

  // AI reviewer panel (step 7) — only when the aiReviewers flag is on. Independent adversarial reviewers read
  // the candidate diff (as untrusted data); all must PASS with no high/critical finding, else REJECTED. The
  // deterministic gate above already makes autonomous deploy safe; this is the "smart" layer on proven rails.
  if (flagOn('aiReviewers')) {
    const diffText = (await gitOut(repoPath, ['diff', `${base}..${prep.sha}`], { maxBuffer: 8 * 1024 * 1024 })).text;
    const rv = await (review || reviewCandidate)({ diffText, files });
    const rdg = digest({ sha: prep.sha, base, files, checks: checks.checks, reviews: rv.reviews });
    if (!rv.pass) return I.transition(integrationId, 'REJECTED', { fenceToken: ft, patch: { checks_digest: rdg, failure_code: 'ai_review_failed' }, data: { blocking: rv.blocking, reviews: rv.reviews } });
    return I.transition(integrationId, 'APPROVED', { fenceToken: ft, patch: { checks_digest: rdg }, data: { checks: checks.checks, reviews: rv.reviews } });
  }
  return I.transition(integrationId, 'APPROVED', { fenceToken: ft, patch: { checks_digest: dg }, data: { checks: checks.checks } });
}

export { PROTECTED };
