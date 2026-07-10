// Fleet thrash detection (operator-requested; the 3-codex fix-relay incident: 10 deploys, login
// regressed repeatedly, three agents overwriting each other on one repo). Detects same-project
// multi-session revert/oscillation or deploy churn within a window, escalates ONCE per episode,
// holds the involved supervisors, and drops a git checkpoint tag before anything else pushes.
//
// detectThrash() is PURE (unit-tested on synthetic history); the git reader and checkpoint helper
// are bounded execFile calls following the evidence-collector safety patterns (timeout + SIGKILL).
import { execFile } from 'node:child_process';

const WINDOW_MS = Number(process.env.AIOS_THRASH_WINDOW_MS || 45 * 60_000);
const REVERT_RX = /\b(revert|reapply|undo|back.?out|roll.?back)\b/i;
const DEPLOY_RX = /^(release|deploy)[:(\s]/i;
const OSCILLATION_MIN = 4; // same file rewritten in >=4 commits inside the window
const DEPLOY_CHURN_MIN = 5; // >=5 release/deploy commits inside the window

function run(cwd, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out)));
  });
}

// git log over the window: [{ sha, ts, subject, files: [] }] newest first.
export async function readRecentCommits(cwd, { windowMs = WINDOW_MS, max = 60 } = {}) {
  const since = new Date(Date.now() - windowMs).toISOString();
  const raw = await run(cwd, ['log', `--since=${since}`, `-n${max}`, '--name-only', '--pretty=format:@@%H|%ct|%s']);
  const commits = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('@@')) {
      const [sha, ct, ...rest] = line.slice(2).split('|');
      cur = { sha, ts: Number(ct) * 1000, subject: rest.join('|'), files: [] };
      commits.push(cur);
    } else if (line.trim() && cur) cur.files.push(line.trim());
  }
  return commits;
}

// PURE: does this commit stream look like thrash? -> { thrash, kind, files, commits, episodeKey }
export function detectThrash(commits, { oscillationMin = OSCILLATION_MIN, deployChurnMin = DEPLOY_CHURN_MIN } = {}) {
  if (!Array.isArray(commits) || commits.length < 3) return { thrash: false };
  const reverts = commits.filter((c) => REVERT_RX.test(c.subject || ''));
  const byFile = new Map();
  for (const c of commits) for (const f of c.files || []) byFile.set(f, (byFile.get(f) || 0) + 1);
  const oscillating = [...byFile.entries()].filter(([, n]) => n >= oscillationMin).map(([f]) => f);
  const deploys = commits.filter((c) => DEPLOY_RX.test(c.subject || ''));
  let kind = null;
  if (reverts.length >= 2 && (oscillating.length || reverts.length >= 3)) kind = 'revert-oscillation';
  else if (oscillating.length && reverts.length >= 1) kind = 'file-oscillation';
  // deploy-churn alone is NOT thrash — a healthy release cadence from one actor looks identical
  // (observed live: 5 releases/45min of normal solo work). The incident shape is deploys FIGHTING
  // regressions, so churn only counts when at least one revert/rollback marker rides the window.
  else if (deploys.length >= deployChurnMin && reverts.length >= 1) kind = 'deploy-churn';
  if (!kind) return { thrash: false };
  const episode = commits[commits.length - 1]?.sha || 'none'; // oldest in-window commit anchors the episode
  return {
    thrash: true,
    kind,
    files: oscillating.slice(0, 8),
    commits: commits.slice(0, 10).map((c) => `${(c.sha || '').slice(0, 7)} ${c.subject}`),
    episodeKey: `thrash|${episode}|${kind}`,
  };
}

// Checkpoint: a lightweight local tag so there is a known-good ref BEFORE anything else pushes.
export async function checkpointRepo(cwd, episodeKey) {
  const tag = `supercalm-checkpoint-${Date.now().toString(36)}`;
  const out = await run(cwd, ['tag', tag]);
  return { tag, ok: out !== null };
}
