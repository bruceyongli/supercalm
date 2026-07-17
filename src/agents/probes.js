// EVIDENCE PROBES (v4 Phase 2, traceability A1/A5; ARCHITECTURE.md §6): evidence is COLLECTED BY
// THE SYSTEM, not asserted by the agent under review. Each probe returns a provenance envelope —
// { type, collector, at, target, result, digest, ms } — so a claim can cite an artifact that a
// verifier (or the operator) can re-run, and "done on my word" has a typed alternative. Probes run
// from the supervising process (outside the agent's writable trust domain); the agent can game its
// own prose, not these.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
const COLLECTOR = 'system/probes@1';
const digest = (s) => createHash('sha1').update(String(s ?? '')).digest('hex').slice(0, 16);
const envelope = (type, target, result, t0) => ({
  type, collector: COLLECTOR, at: Date.now(), target: String(target || '').slice(0, 300),
  result, digest: digest(JSON.stringify(result)), ms: Date.now() - t0,
});

// Repo truth: HEAD sha, dirty state, branch — the provenance every "it's committed/deployed" claim
// must anchor to. Never trusts agent output; asks git directly.
export async function gitProbe(repoPath) {
  const t0 = Date.now();
  try {
    const g = (...a) => run('git', ['-C', repoPath, ...a], { timeout: 8000 }).then((r) => r.stdout.trim());
    const [sha, branch, status] = await Promise.all([g('rev-parse', 'HEAD'), g('rev-parse', '--abbrev-ref', 'HEAD'), g('status', '--porcelain')]);
    return envelope('git', repoPath, { ok: true, sha, branch, dirty: status.length > 0, dirtyFiles: status ? status.split('\n').length : 0 }, t0);
  } catch (e) {
    return envelope('git', repoPath, { ok: false, error: String(e?.message || e).slice(0, 200) }, t0);
  }
}

// Live-deliverable truth: does the URL actually serve? Status + body digest (so "it changed" is
// checkable across probes). Bounded; never follows the agent's word for reachability.
export async function urlProbe(url, { timeoutMs = 8000 } = {}) {
  const t0 = Date.now();
  try {
    const ctl = AbortSignal.timeout(timeoutMs);
    const r = await fetch(url, { signal: ctl, redirect: 'follow' });
    const body = await r.text();
    return envelope('url', url, { ok: r.ok, status: r.status, bodyBytes: body.length, bodyDigest: digest(body) }, t0);
  } catch (e) {
    return envelope('url', url, { ok: false, error: String(e?.message || e).slice(0, 200) }, t0);
  }
}
