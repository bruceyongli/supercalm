# Runbook: "Supercalm is unreachable"

*Diagnostic methodology + the 2026-06 incident where the cause turned out to be **host asleep**, not an
Supercalm bug — and the robust never-sleep fix. Use this when `https://host.your-tailnet.ts.net/aios` stops
loading.*
**Status:** ✅ Diagnosis methodology proven. 🟡 Robust never-sleep fix specified, pending application (needs host awake).

See also: [[infra-and-networking]] · [[auth-architecture]]

---

## First principle: separate the three failure layers
Unreachable Supercalm is **one of three** very different things. Diagnose in this order — don't assume the app:
1. **App down** — Supercalm process crashed (e.g. a bad deploy / dangling import after a refactor).
2. **Machine down** — host asleep / wedged / powered off.
3. **Network path** — Tailscale relay/DERP or routing between you and host.

## Decision tree
```
curl 127.0.0.1:8793/healthz ON host (via LAN SSH if Tailscale path is down)
 ├─ 200  → app is fine. Problem is the PATH → check `tailscale serve status`, DERP health.
 └─ fail/can't-SSH → is the MACHINE reachable at all?
      tailscale status | grep host   (Online? relay? )
      tailscale ping host            (data-plane)
      ping a SIBLING on the LAN (another node on the same /24)  ← calibrates YOUR network
       ├─ siblings OK, host dead on ALL TCP ports (22/8793/8791/5900) → host ASLEEP/WEDGED  → §incident
       └─ siblings also dead → YOUR network / DERP → `tailscale netcheck`, restart your tailscaled
```

## ⛔ Liveness signals that LIE (learned the hard way)
On a **sleeping** Mac these all still respond, so they are **not** proof of life:
| Signal | Why it lies |
|---|---|
| `tailscale status` → `Online: True` | Power-Nap posts control-plane keepalives during sleep |
| ARP resolves host's MAC on the LAN | the NIC answers L2 ARP while the OS sleeps |
| the host's `.local` name resolves (mDNS) | a **Bonjour sleep proxy** keeps the name registered |
| `ping` fails | host's **stealth firewall** drops ICMP even when awake — failing ping proves nothing |

✅ **The only reliable test: a TCP connect to an OPEN port** (SSH 22, or any listening service). If
**every** TCP port black-holes while LAN **siblings answer**, the machine is asleep/wedged — full stop.

## The 2026-06 incident (worked example)
Symptom: `/aios` URL dead; user said "mac is working fine."
- `tailscale status`: host `active`, **routed via a distant DERP relay, no direct path**, `Online:True`.
- My own DERP fine (netcheck), and **another relayed peer answered in ~1s**
  → not my network, not the relay.
- I was on host's **LAN**. Sibling nodes (`.1` router, the voice device) reachable; **host: ping, SSH 22,
  Supercalm 8793, proxy 8791, VNC 5900 ALL timed out.** ARP + mDNS + control-keepalive alive.
- **Conclusion: host asleep.** Wake-on-LAN (sustained 60s magic-packet burst) did **not** wake it →
  consistent with Wi-Fi sleep without a sleep-proxy wake (see [[infra-and-networking]]).
- Note: Supercalm binds `127.0.0.1`, so even on the LAN you can't reach it directly — the LAN is only an
  **SSH** bypass to *operate* host, not to reach Supercalm.

⟹ Resolution required a **physical wake** (tap key / open lid). Remote WoL was not available.

## The robust fix (apply once host is awake — never-sleep + self-heal)
```bash
# never sleep on power; wake on magic packet; auto-restart after power loss/freeze
sudo pmset -c disablesleep 1 sleep 0 disksleep 0 displaysleep 0 powernap 1 womp 1 autorestart 1
```
Plus:
- A **`caffeinate`** launchd keep-awake (belt-and-suspenders).
- A small **watchdog** (launchd) that pings Supercalm + tailscaled and restarts them / re-asserts `tailscale
  serve` if either drops.
- **Disable Tailscale key expiry** for host in the admin console (so it never silently needs re-auth).
- 🔵 Optional: bind Supercalm to `0.0.0.0` so it's LAN-reachable when Tailscale flakes (flag the no-auth-on-LAN
  trade-off first — see [[infra-and-networking]]).

If allowing display sleep is desired, drop `displaysleep 0` but keep `disablesleep 1 sleep 0` (system
never sleeps, screen can).

## Wake-on-LAN note
WoL magic packet = 6×`0xFF` + target MAC ×16, UDP broadcast to the LAN broadcast address `…255:9` (and
`:7`) with host's own MAC. ⚠️ Works only from sleep (not power-off) **and** only if host has "Wake for
network access" enabled — which over **Wi-Fi** needs a Bonjour sleep-proxy. On host it did **not** wake →
don't rely on remote WoL; the never-sleep `pmset` above is the real prevention.
