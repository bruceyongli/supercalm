// Resume isolation policy — a pure predicate, deliberately dependency-free so it can be unit-tested and
// reasoned about in isolation from the heavy sessions.js runtime.
//
// A session that was launched into an isolated git worktree carries its `worktree_path` on the DB row.
// On resume, sessions.js re-attaches (or re-creates) that worktree and derives the pane cwd from it. If
// restoration produces NO cwd — the worktree add failed, the branch is gone, the disk is unavailable —
// the *old* behavior fell back to the shared project checkout. That silently drops the deploy interlock:
// startPane computes `isolated = cwd !== project.path` → false for the shared tree, so it omits
// AIOS_NO_DEPLOY=1, and an automatic recovery relaunch (supervisor exit-recovery, force:true) can end up
// running an agent in the live deployment checkout while the DB row still points at the missing worktree.
//
// So isolation is a HARD invariant on resume: restore the recorded worktree, or refuse. `force` exists to
// override a launch-manifest mismatch (healing lost flags); it must NEVER be read as permission to escape
// isolation. Any relaxation for a deliberate manual "resume in the shared tree" must be a separate,
// explicitly-authorized option — never inferred from `force`.
export function isolationResumeBlocked({ worktreePath, restoredCwd } = {}) {
  return !!(worktreePath && !restoredCwd);
}
