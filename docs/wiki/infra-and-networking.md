# Infrastructure & Networking

*Where Supercalm runs, how it's reached, and how it's deployed. The non-obvious bits: the additive Tailscale
Serve mapping, why Supercalm binds loopback-only, and the LAN/Tailscale topology that matters when host goes
quiet (see [[runbook-host-unreachable]]).*
**Status:** ✅ Current. · See also `CLAUDE.md` "Run & deploy".

See also: [[runbook-host-unreachable]] · [[proxy-fleet]] · [[auth-architecture]]

---

## The host
- An **always-on MacBook Pro** (the reference host in these docs). User `host`, home `/Users/host`.
- **Tailscale IP:** `100.x.y.z` (tailnet `your-tailnet.ts.net`). **LAN:** `192.168.1.x` (home router
  `192.168.1.1`; same /24 as the voice device and other nodes). *(Placeholders — use your own values.)*
- ⚠️ **MacBook → `en0` is Wi-Fi**, even though ARP labels it `[ethernet]`. Consequence: **Wake-on-LAN is
  unreliable** (needs a Bonjour sleep-proxy many home routers won't provide) — see [[runbook-host-unreachable]].
- ⚠️ **Stealth-mode firewall:** host drops ICMP echo and probes to closed ports, so `ping`/`nc -z` fail
  even when it's up — the meaningful liveness test is an **SSH/TCP connect to an open port**, not ping.

## How Supercalm is reached
- Supercalm listens on **`127.0.0.1:8793`** (loopback only — `HOST` default `127.0.0.1`). ⟹ It is **not**
  reachable on the LAN IP directly; the only external path is Tailscale Serve.
- **Primary URL:** `https://host.your-tailnet.ts.net/aios` (no port). **Fallback:** `:8793`.
- **Path-aware:** `<base href="/aios/">` + relative URLs + a server-side `/aios` prefix-strip in
  `server.js`, so the Serve path and direct `:8793` route identically.

### ⛔ The Tailscale Serve model (additive, do not break)
host's **443 root `/`** is the model-proxy dashboard (antigravity 8791) — **off-limits**. The Supercalm mapping
is **additive**: `tailscale serve --bg --https=443 --set-path=/aios http://127.0.0.1:8793`. `bin/expose`
(run on host) sets it idempotently. ⛔ Per [[proxy-fleet]], **API ports must never use `tailscale serve`**
(tailscaled would collide on the port → `EADDRINUSE`); only dashboards/paths do.

## Deploy & run
- **launchd:** `ai.aios.server`. Restart: `launchctl kickstart -k gui/$(id -u)/ai.aios.server`.
- **Deploy (git-only):** `bin/deploy` → push to GitLab (`git@gitlab.com:your-org/aios.git`) → `git pull
  --ff-only` on host → restart. ⛔ Edit on the dev Mac, push, pull — never edit tracked files directly on
  host or the next `--ff-only` rejects.
- **Logs / data:** `~/aios/data/aios.log`; sqlite + per-session raw logs + vapid keys in `~/aios/data/`
  (gitignored).
- **Health:** `curl 127.0.0.1:8793/healthz` and `/api/state`.

### Disk health and operator-controlled cleanup

Health → **Disk usage** shows filesystem headroom, project source and session storage separately,
plus the largest sessions (including protected running sessions). An on-demand, cached background
inventory uses allocated disk blocks, at most two bounded `du` processes, and counts nested scopes
once. Unmeasurable paths are explicit errors, not silently accurate zeros. APFS clones/hardlinks can
share physical blocks, so inventory and reclaimable sizes are estimates.

Stopped sessions can be selected by project, then cleaned in one confirmed batch:

- **Temp/logs** retains conversation records, saved outputs, uploads and native CLI history.
- **Outputs** additionally removes explicitly selected saved outputs/uploads and safe worktrees.
- **Delete killed sessions** removes AIOS conversation records and managed files only after an
  explicit operator Kill. A Stop remains resumable and cannot be mistaken for Kill.

The server previews exact targets and revalidates durable intent, actual tmux absence, paths,
symlinks, session/resume races and clean/merged Git state before deletion. It never force-removes a
dirty/unmerged worktree, deletes project source folders, touches the proxy fleet, or substitutes a
different session. Retry receipts cannot delete files created after the original cleanup. Partial
failures report paths already removed. Cleanup is irreversible; nothing is auto-selected/deleted.
Project task/evidence/decision/usage/integration audit records and native CLI histories are retained.
Deleting SQLite records makes pages reusable but does not immediately shrink the database file;
there is no automatic live VACUUM or checkpoint of the operator's database.
The dashboard shows SQLite's internal reusable pages separately from free filesystem space.
Cleanup receipts separate estimated removed file blocks from the measured filesystem capacity
before/after deletion. The net change includes concurrent writes by other sessions/apps; it is not
a promise of physically reclaimed blocks. A pending inventory is shown as measuring, not zero.
In temp/logs mode, a session's total occupied size is explicitly not the selected cleanup amount.
While Health is visible, live capacity refreshes every ten seconds and on focus via the metadata-only
`GET /api/product/storage/capacity`; this does not rerun `du` or download the full session inventory.

Launch hygiene asks agents to reuse isolated Git worktrees for the same repository, use shallow
clones only when full history is unnecessary, and remove their own disposable clones/build copies
after last use. Full clones remain available when required. Clones must use managed scratch
storage; this is guidance, not a transparent rewrite of arbitrary Git commands or a disk quota.

A lightweight capacity monitor runs every minute and alerts devices on warning/escalation (rate
limited). Warning: less than 10% available or 20 GiB. Critical: less than 5 GiB; new/resumed agents
are refused **before** reserving a new session or killing a pane. Existing agents are not killed and
files are not silently purged. This is early warning/admission control, not a filesystem quota:
already-running agents or other applications can still consume space. Operator overrides:
`AIOS_DISK_WARNING_BYTES`, `AIOS_DISK_RESERVE_BYTES`.

API: `GET /api/product/storage` (nonblocking cached scan/status), `?fresh=1` (coalesced rescan),
`POST /api/product/storage/plan`, then `POST /api/product/storage/cleanup` with the returned plan id
and explicit `confirm:true`. Product Health also includes current capacity without a full scan.

## Reachability fix idea (proposed)
Because Supercalm is loopback-only, a Tailscale hiccup makes it unreachable even when host + Supercalm are fine. A
🔵 proposed hardening: optionally bind Supercalm to `0.0.0.0` so it stays reachable on the home LAN as a
fallback — with the security trade-off (no auth on the LAN) flagged before enabling. See the robust-fix
list in [[runbook-host-unreachable]].

## Dev vantage point
The dev Mac (a second tailnet node) is sometimes on **host's physical LAN** (`192.168.1.x`) — which
is how the [[runbook-host-unreachable]] incident was diagnosed (LAN sweep + ARP) and how a LAN-IP SSH
bypass is possible when the Tailscale path is down.
