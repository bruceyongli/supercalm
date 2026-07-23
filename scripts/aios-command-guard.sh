#!/usr/bin/env bash
# Best-effort deploy-source enforcement for agent shells, including Codex (which does not expose
# Claude's PreToolUse hook). This script is reached through scripts/guard-bin/* wrappers placed first
# on PATH at launch. It is intentionally inert unless AIOS_NO_DEPLOY or a project release contract is
# present, and always delegates non-deploy commands byte-for-byte.
set -u

tool="${AIOS_GUARDED_COMMAND:-$(basename "$0")}"
guard_bin="$(cd "$(dirname "$0")/guard-bin" 2>/dev/null && pwd -P || true)"

clean_path=""
old_ifs="$IFS"
IFS=:
for entry in ${PATH:-}; do
  [ -n "$entry" ] || entry="."
  resolved="$(cd "$entry" 2>/dev/null && pwd -P || true)"
  [ -n "$guard_bin" ] && [ "$resolved" = "$guard_bin" ] && continue
  clean_path="${clean_path:+$clean_path:}$entry"
done
IFS="$old_ifs"

real="$(PATH="$clean_path" command -v "$tool" 2>/dev/null || true)"
if [ -z "$real" ]; then
  printf 'Supercalm command guard: cannot find the real %s executable\n' "$tool" >&2
  exit 127
fi

joined=" $* "
deploy=0
direct_vendor=0
case "$tool" in
  wrangler)
    if [[ "$joined" =~ [[:space:]](pages[[:space:]]+)?deploy([[:space:]]|$) ]]; then deploy=1; direct_vendor=1; fi
    ;;
  vercel)
    if [[ "$joined" =~ [[:space:]](--prod|deploy)([[:space:]]|$) ]]; then deploy=1; direct_vendor=1; fi
    ;;
  netlify)
    if [[ "$joined" =~ [[:space:]]deploy([[:space:]]|$) ]]; then deploy=1; direct_vendor=1; fi
    ;;
  npm|pnpm|yarn)
    [[ "$joined" =~ [[:space:]](run|run-script)[[:space:]]+[^[:space:]]*(deploy|publish|release) ]] && deploy=1
    if [[ "$joined" =~ [[:space:]](exec|dlx)[[:space:]].*(wrangler|vercel|netlify).*[[:space:]](pages[[:space:]]+)?deploy([[:space:]]|$) ]]; then deploy=1; direct_vendor=1; fi
    ;;
  npx|bunx)
    if [[ "$joined" =~ [[:space:]](wrangler|vercel|netlify).*[[:space:]](pages[[:space:]]+)?deploy([[:space:]]|$) ]]; then deploy=1; direct_vendor=1; fi
    ;;
  bun)
    [[ "$joined" =~ [[:space:]](run|x)[[:space:]].*(deploy|publish|release) ]] && deploy=1
    [[ "$joined" =~ [[:space:]]x[[:space:]].*(wrangler|vercel|netlify) ]] && direct_vendor=1
    ;;
esac

if [ "$deploy" -eq 0 ]; then
  PATH="$clean_path" exec "$real" "$@"
fi

deny() {
  printf 'Supercalm deploy guard blocked: %s\n' "$1" >&2
  printf 'Deploy from the declared release checkout through its reviewed release path; isolated agent worktrees must integrate first.\n' >&2
  exit 126
}

[ "${AIOS_NO_DEPLOY:-0}" = "1" ] && deny "this session is an isolated worktree and cannot deploy directly"

source_dir="${AIOS_DEPLOY_SOURCE_DIR:-}"
if [ -n "$source_dir" ]; then
  source_real="$(cd "$source_dir" 2>/dev/null && pwd -P || true)"
  cwd_real="$(pwd -P 2>/dev/null || true)"
  [ -n "$source_real" ] || deny "the declared source directory does not exist: $source_dir"
  [ -n "$cwd_real" ] || deny "the deploy working directory could not be resolved"
  case "$cwd_real/" in
    "$source_real/"*) ;;
    *) deny "working directory '$cwd_real' is outside the declared source '$source_real'" ;;
  esac

  expected_branch="${AIOS_DEPLOY_BRANCH:-}"
  if [ -n "$expected_branch" ]; then
    actual_branch="$(git -C "$cwd_real" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    [ -n "$actual_branch" ] || deny "the deploy working directory is not inside the declared Git checkout"
    [ "$actual_branch" = "$expected_branch" ] || deny "branch '$actual_branch' is not the declared release branch '$expected_branch'"
  fi

  # A direct vendor command enforces only WHERE it ran; it skips the repository's reviewed build,
  # artifact-integrity, monotonic-version, and smoke gates. Under a release contract, only a package
  # release script (npm/pnpm/yarn/bun run deploy) may reach the vendor CLI. Delegation above removes
  # guard-bin from the child PATH, so that reviewed script can invoke its real vendor binary.
  [ "$direct_vendor" -eq 1 ] && deny "direct vendor deploy bypasses the repository's reviewed release command"
fi

PATH="$clean_path" exec "$real" "$@"
