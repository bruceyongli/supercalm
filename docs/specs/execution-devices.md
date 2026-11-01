# Local execution devices

Operator contract (2026-11-01): one Supercalm UI controls coding sessions on bb1 and bb2.
Execution working sets are on the executing Mac's SSD: complete Git object database,
worktree, dependencies, native conversation and SQLite. Spark is for cold archives/backups,
not a build/checkout/history mount. Existing originals are not removed by device migration.

## Ownership and transport

An execution device runs the SAME session/input/Story runtime, supervised by launchd.
SSH forwards private loopback APIs and a callback to the central model gateway. SSH loss
does not end sessions. The central registry owns routing; runtime observations and messages
are mirrored for the common dashboard/attention queue. A worker-owned row must never enter
the central tmux reconciler, cleanup or supervisor. Offline is not exited.

New sessions choose an execution device. An existing project is materialized as a complete
local repository before launch, not a linked checkout whose Git objects remain on Spark.
Remote sessions use the central model gateway; subscription credentials are not copied.

## Paused-session handoff

Only explicitly stopped, non-writing sessions are eligible. Bind the AIOS ID, native UUID,
source checkout HEAD/index/dirty files and destination node in a durable operation. Acquire
the existing session storage lease and fence all lifecycle mutations. Stage a full Git bundle,
working files and exact native transcript without changing source files. Transfer verification
uses streaming digests and identity checks, not a second whole-corpus scan. Reject external
symlink dependencies and unresolved submodules rather than silently omit work.

Destination imports dormant state first. Commit central ownership only after import succeeds;
only the destination owner may activate. Failures keep originals and the original owner. A
restart reconciles the same operation, never creates a new conversation or starts both copies.
Keep original location/manifest and source-to-destination path aliases for historical previews.

## Acceptance

- Device health and selector; local default, no arbitrary SSH/browser command injection.
- Start a real disposable Codex and Claude session on bb2; prove native response + Story.
- Stop, migrate an owned test session with dirty/staged/untracked files, resume the SAME UUID.
- Send one request and prove native acceptance without duplication; preview migrated files.
- Reconnect transport/restart service; preserve owner and session identity.
- Local regression suites and production browser gate; release only via bin/deploy.
