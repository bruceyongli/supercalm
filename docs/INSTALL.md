# Installing Supercalm — a guide for a coding agent

**Audience: a CLI coding agent (Claude Code, Codex, or similar) installing Supercalm for its operator.**
Work top-to-bottom. After each step, run the **Verify** command and do not proceed until it passes. If a
step fails, stop and report the exact command + output — don't guess past it. Prefer the operator's
existing tools; never paste secrets into tracked files.

Supercalm is a self-hosted Node service (no framework, no database server) that runs CLI coding agents in
tmux and gives the operator a web console with voice/text control. It binds to loopback only.

---

## 0. Preflight — confirm the host meets the requirements

```bash
node --version        # need v22 or newer
tmux -V               # required — every agent runs inside tmux
git --version
ffmpeg -version | head -1 || echo "ffmpeg missing (only needed for voice)"
```

- **Node < 22 or missing** → install Node 22+ (`brew install node` on macOS; nodesource/`nvm` on Linux) and re-check.
- **tmux missing** → `brew install tmux` (macOS) or `sudo apt-get install -y tmux` / `sudo dnf install -y tmux` (Linux).
- **ffmpeg missing** → optional; only needed for voice. Install later if the operator wants voice.

**Verify:** `node --version` prints `v22.*` (or higher) and `tmux -V` prints a version. ✅ proceed.

## 1. Get the code

```bash
git clone https://github.com/bruceyongli/supercalm.git
cd supercalm
```

If it's already cloned, `cd` into it and `git pull`.

**Verify:** `ls package.json src/server.js` lists both files.

## 2. Install dependencies

```bash
npm install
```

Runtime deps are tiny (`web-push` + the AG-UI packages); xterm.js and graph libs are vendored, so this is
quick and needs no build step.

**Verify:** `npm test` runs and ends with the suite passing (all test files print `ok` / `passed`). This
also confirms the Node/tmux environment is sane. ✅ proceed.

## 3. Configure (optional but recommended)

An empty config is valid — Supercalm runs on defaults. Create the local, gitignored env file only to set
what differs for this host:

```bash
cp .env.example data/aios.env
```

Then edit `data/aios.env`. The **most common** things an operator sets:

- `AIOS_SELF_URL` — the public URL they'll open (e.g. their Tailscale Serve URL).
- **External model proxy** — if they run a local model proxy that needs a token, set `AIOS_PROXY_KEY`.
  A keyless local proxy needs nothing. No proxy at all is fine (summaries/voice/supervisor degrade).
- **Voice** — if they have a Whisper/TTS device, set `SPARK_IP` + `SPARK_HOST`. No device → skip, or set
  `AIOS_TTS_BACKEND=local` for on-device macOS TTS.

Full reference: [`docs/CONFIGURATION.md`](CONFIGURATION.md). **Do not** hardcode any of these in `src/` —
they belong in `data/aios.env`. Ask the operator for device IPs / tokens; never invent them.

**Verify:** `test -f data/aios.env && echo ok` (or skip this step entirely for defaults).

## 4. Install the secret-scan git hooks

So no private data can ever be committed or pushed from this clone:

```bash
bin/install-hooks
node scripts/scan-secrets.mjs      # should print: ✓ secret-scan clean
```

**Verify:** the scan prints `✓ secret-scan clean`.

## 5. Start it

**Foreground (to confirm it boots):**
```bash
npm start
```
Then, in another shell:
```bash
curl -sS http://127.0.0.1:8793/healthz
```

**Verify:** healthz returns JSON with `"ok":true` and a `version`. Stop the foreground process once
confirmed.

**As a background service (recommended for real use):**
```bash
bin/install-service        # launchd (macOS) / systemd (Linux) user service: auto-start + restart-on-crash
```

**Verify (service):** after a few seconds, `curl -sS http://127.0.0.1:8793/healthz` again returns
`"ok":true`. The service now survives logout/reboot.

## 6. Reach it from other devices (optional)

Supercalm binds loopback, so expose it over the operator's private network — **never the public
internet.** With Tailscale:

```bash
bin/expose                 # tailscale serve --set-path=/aios -> 127.0.0.1:8793 on 443
```

Then it's at `https://<node>.<tailnet>.ts.net/aios`. Without Tailscale, put it behind an authenticated
reverse proxy on the operator's LAN/VPN.

**Verify:** open the URL (or `curl` it) from another device on the tailnet; the dashboard loads.

## 7. Log the agents in

Coding agents authenticate through their own CLIs. Have the operator run each tool once and complete its
login (or use the in-app **Auth** page at `/aios/auth`):

```bash
claude    # then /login
codex     # then its login
agy       # then its login
```

**Verify:** open the dashboard → **+ Session**, pick a project path + a tool, launch a trivial task, and
confirm the live terminal streams and the session shows as *working*. ✅ install complete.

---

## 8. Updating later

When the dashboard shows the **"Update available"** toast (or on request):

```bash
bin/update
```

It fast-forward pulls, reinstalls deps, and restarts the service; it refuses if the operator has local
edits (report that instead of forcing).

**Verify:** `curl -sS http://127.0.0.1:8793/healthz` shows the new `version`.

---

## Troubleshooting

- **`/healthz` not responding** → check the log: `tail -50 data/aios.log` (or `bin/logs`). A dangling
  import after an edit is the usual cause; the message names the file.
- **Agents don't launch / "tmux" errors** → `tmux -V` must work; set `AIOS_TMUX` to its absolute path if
  it's outside the common bin dirs (launchd/systemd have a minimal `PATH`).
- **Voice does nothing** → needs `ffmpeg` + a configured `SPARK_IP`/`SPARK_HOST`, or `AIOS_TTS_BACKEND=local`.
- **"Please run /login" in a session** → that agent's CLI isn't authenticated; do step 7 for that tool.
- **A commit/push is blocked by the secret-scan** → it found private data; move it into `data/aios.env`.
  See [`docs/CONFIGURATION.md`](CONFIGURATION.md#keeping-secrets-out-of-git).

Report the final dashboard URL and the list of authenticated tools to the operator.

## Verify your install end-to-end

```bash
bin/e2e-install
```

Clones your checkout into a temp dir, installs, boots on its own port/data dir, adds a mock API
model provider through the public API, proves models join the catalog and the internal transport
routes to them, smokes the core API, and (if tmux + a coding CLI are present) launches and kills a
real throwaway session. 0 failures = a stranger's laptop would work.

To use real API models instead of a local proxy fleet: open **/auth → "API model providers"** and
add your Anthropic or OpenAI-compatible endpoint + key (see docs/CONFIGURATION.md).
