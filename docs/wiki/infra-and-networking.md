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

## Reachability fix idea (proposed)
Because Supercalm is loopback-only, a Tailscale hiccup makes it unreachable even when host + Supercalm are fine. A
🔵 proposed hardening: optionally bind Supercalm to `0.0.0.0` so it stays reachable on the home LAN as a
fallback — with the security trade-off (no auth on the LAN) flagged before enabling. See the robust-fix
list in [[runbook-host-unreachable]].

## Dev vantage point
The dev Mac (a second tailnet node) is sometimes on **host's physical LAN** (`192.168.1.x`) — which
is how the [[runbook-host-unreachable]] incident was diagnosed (LAN sweep + ARP) and how a LAN-IP SSH
bypass is possible when the Tailscale path is down.
