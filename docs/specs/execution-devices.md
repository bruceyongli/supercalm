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

Slow/network sources stream Git evidence with classified deadlines rather than a 16 MiB stdout
ceiling or a one-minute scan deadline. A disposable local mirror may seed published objects from
the existing origin, copies source packs sequentially and hydrates missing reachable objects.
Only the source HEAD/refs/index select the result. Include index-only blobs, not just index metadata.
Later sessions in the same project may reuse already-received destination objects after an exact
HEAD/index-object check. Every checkout is independent: no alternates, source hardlinks or hooks.
Receiver-only Git receipts are not proof that the source exporter completed. Reuse only a bound,
successfully generated local seed; validate bundle headers and sizes before acknowledging or unpacking.
An exact, unimported legacy operation can repair an invalid Git receipt without replacing its identity,
checkout or other transferred parts. Active transfers and imported sessions cannot enter that repair.

Registered archived worktrees stream directly from SSH storage to the destination. Validate the
original reciprocal Git registration, HEAD/index receipt and before/after remote fingerprint;
the archive's old local inode fingerprint is not comparable to remote inodes. Artifact archives
are also copied with transfer receipts. No source archive is evicted or overwritten.
Untracked root links into the same session's scratch (such as node_modules) are copied locally;
ignored links may materialize, while visible untracked links retain their symlink shape into the
reserved, Git-excluded `.aios/execution-dependencies` directory. Tracked/external links remain
blocked. Dependency writers and changed per-file identities stop the move, never delete originals.

Operator-selected `rebuildDependencies: true` keeps ignored dependency/build caches at the source.
The separate `coldBuildPaths` allowlist can retain specifically approved unignored build outputs;
it rejects tracked descendants and arbitrary paths. Source, staged changes, other untracked files,
reports and conversations still move. Original Git identity remains bound, with a separate working
state digest for the retained hot files. Scoped dependency links become local empty rebuild targets,
not pointers to Spark. The destination manifest records cold original paths. This choice can upgrade
the same receiving operation and retain its Git receipts, but never change an imported operation.
No cold path is deleted. Artifact directories use bounded parallel reads too. With this explicit
choice, their `node_modules` and Python environments identified by `pyvenv.cfg` remain cold.
Legacy external `node_modules` symlinks can rebuild into empty local targets only when their recorded
target belongs to this exact project or a recorded same-project workspace, and neither HEAD nor the
copied index tracks that path or its descendants. The immutable operation policy binds these roots;
never infer a wider shared parent. A worker-local derived archive rewrites those links, passes the
normal archive validator and is removed after extraction. Keep the received archive's receipt and
all source originals; arbitrary external links and tracked dependency links still fail closed.
Compiled `.app` bundles (with `Contents/Info.plist`), DMG images and ZIPs containing an app bundle
also stay at source; ordinary source/report ZIPs are retained in the transfer. Policy v2 can upgrade
an exact receiving v1 operation without replacing its Git/native receipts. Other
reports, media and ordinary directories named `venv` are still copied. This policy and the original
artifact root are recorded in the destination manifest. Retries reuse completed native-history
and report receipts as well as Git receipts, rather than resending multi-gigabyte conversations.

The separate explicit `retainHistoricalArtifacts: true` option (batch flag
`--retain-historical-artifacts`) copies report text only from artifacts and uploads, including
registered SSH artifact archives. Markdown, plain text, HTML, CSV/TSV, reStructuredText and AsciiDoc
move; screenshots, recordings, JSON/debug traces and other original attachments stay untouched at
their registered source. Policy v3 upgrades only a receiving transfer, retaining hot code, Git and
native-history receipts. Original report URLs remain controller-served with normal session evidence
and scope checks, including rendered HTML assets and range downloads; new bb2 outputs stay worker-
served. Thus cold media requires the controller and source storage, but coding does not. A missing
source produces an availability error, not an empty replacement file. Transfer timeouts measure
stalled progress rather than total duration; receipt acceptance also requires source EOF.

Explicit `preserveHistory: true` permits moving older stopped records whose native transcript was
already unavailable. First check the exact UUID, including identity-bound retained-original migration
journals. A history-only result is labelled and cannot Resume (including force), borrow another
conversation or create a new one. Existing messages, files, dismissal/activity clocks and original
locations remain. It is not reported as a successfully recovered native conversation. Once every
session belongs to a device, the project execution-device API can select that owner for new launches
without changing its original release authorization/source contract.

## Acceptance

- Device health and selector; local default, no arbitrary SSH/browser command injection.
- Start a real disposable Codex and Claude session on bb2; prove native response + Story.
- Stop, migrate an owned test session with dirty/staged/untracked files, resume the SAME UUID.
- Send one request and prove native acceptance without duplication; preview migrated files.
- Reconnect transport/restart service; preserve owner and session identity.
- Local regression suites and production browser gate; release only via bin/deploy.
