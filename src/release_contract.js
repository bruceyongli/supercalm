// A deploy-source declaration is atomic: directory-only permits a stale branch, while branch-only
// cannot prove where the release command ran. Keep this pure so configuration validation is easy to
// test without booting the HTTP server that owns release-monitor routes.
export function assertCompleteReleaseSource(sourceDir, sourceBranch) {
  if (!!sourceDir !== !!sourceBranch) throw new Error('source_dir and source_branch must be configured together');
  return Boolean(sourceDir && sourceBranch);
}
