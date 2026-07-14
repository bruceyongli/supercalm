# Release system — versioning, deploy, channels, and (forthcoming) autonomous deploy

*How a change goes from a commit to the live service, how releases are versioned + notified, and the
plan to let agents deploy themselves safely. Companion to [`CLAUDE.md`](../../CLAUDE.md) (the deploy
rules) and [[design-decisions]].*

## TL;DR
- **One version, one source:** `package.json` `version`. **`bin/version` is the ONLY thing that edits
  it** (bump → commit `release: vX.Y.Z` → annotated tag). The server reads it once at boot
  (`config.js` `VERSION`) and serves it at `/api/version` · `/healthz` · `/api/state`.
- **Two release paths:** `bin/deploy` = every-release (routine, frequent); `bin/release` = **stable**
  (test-gated, GitHub Release, marks the channel). Both bump + push + restart; deploy is Git-only.
- **Release channels** let a user choose when the new-version toast nudges them: **Stable only**
  (default) · Every release · Off — so frequent auto-deploys don't spam the dashboard.
- **Push works headless** via the `GITHUB_PAT_AIOS` credential helper (§4); never report agent pushes as
  broken.
- 🔵 **Autonomous integrate-&-deploy** (agents ship their own branch, gated by a multi-agent check
  pipeline + rollback) is designed + approved, being built MVP-first — spec:
  [`docs/specs/autonomous-deploy-plan.md`](../specs/autonomous-deploy-plan.md).

---

## 1. The version is single-source ⛔
`package.json` `version` is the only place the version lives; **nothing else hardcodes it**
(`config.js` comment enforces this). `bin/version <patch|minor|major|X.Y.Z>`:
- `npm version --no-git-tag-version` rewrites `package.json` + `package-lock.json`,
- (when `COMMIT=1`) commits `release: vX.Y.Z` + annotates tag `vX.Y.Z`,
- prints the bare version on stdout.

`bin/deploy` calls it on **every** deploy, so deploying inherently increments + propagates the version
everywhere. **Never hand-edit the version.**

## 2. Two release paths

| | `bin/deploy` (every-release) | `bin/release` (stable) |
|---|---|---|
| **Purpose** | routine ship (the common path; the autonomous pipeline will use it) | a blessed, milestone release |
| **Gates** | clean tree · not a linked worktree · branch `main` · secret scan · ff-sync to origin | all of those **+ the full `npm test` suite** (`RELEASE_SKIP_TESTS=1` emergencies only) |
| **Version** | `bin/version <level>` (default patch) | `bin/version <level>` |
| **Push** | `git push origin main --follow-tags` (PAT helper, §4) | same |
| **GitHub Release** | no | **yes** (`generate_release_notes`) — what upstream `bin/update` checks poll |
| **Channel marker** | none → `every` | writes `data/release_channel.json` `{version, channel:"stable"}` → `stable` |
| **Restart** | on-host: `launchctl kickstart -k` locally; else ssh + ff-merge + restart | scoped local restart |
| **Evidence** | — | appends to `data/release-evidence.log` |

`bin/deploy` **refuses from a linked worktree / non-`main` / `AIOS_NO_DEPLOY=1`** (multi-agent safety),
detects it's on the deploy target (`pwd == realpath(~/aios)` + the launchd service) and restarts locally
rather than ssh-ing. Deploy from **one** machine — it fast-forwards to `origin/main` first.

## 3. Release channels + the new-version toast
Autonomous deploy makes releases frequent, so an undifferentiated reload toast would spam anyone watching.
Each release now carries a **channel**, and the toast filters by the user's preference.

- **Marking:** a release is `stable` only when `bin/release` blessed **that exact version** (it writes
  `data/release_channel.json`). `config.js` `RELEASE_CHANNEL` reads it at boot; routine `bin/deploy`
  every-releases leave it `every`. **Fail-safe:** any missing/mismatched/corrupt marker → `every`.
- **Surfaced:** `GET /api/version` → `{ version, channel }`.
- **The toast** (`web/version-badge.js`) records the version at page-load, polls `/api/version` (30s +
  on focus/visibility/online), and:
  - **Stable only** (default): reload nudge only when a **stable** release lands; routine auto-deploys
    are silently skipped (the loaded page keeps running against the newer backend — accepted skew).
  - **Every release**: nudge on any bump (the original behavior).
  - **Off**: no reload nudge, no upstream nudge.
- **Control:** Settings → Preferences → **Release notifications** (`localStorage aios_release_notify`,
  default `stable`).
- 🟡 **Producer swap (planned):** today "stable" = human `bin/release`. When the autonomous pipeline's
  deploy-ledger + health verification land, a **soaked-green** release (live N hours, no rollback) can be
  auto-promoted to `stable` by writing the same marker — API / settings / toast are unchanged, only the
  producer of the stable bit swaps. This is the right signal for an autonomous world (proven-in-prod, no
  human needed) — see [[design-decisions]].

## 4. Headless GitHub push (PAT) ⛔
`origin` = `https://github.com/bruceyongli/supercalm.git` (HTTPS). The osxkeychain helper needs a GUI/TTY,
so agent shells authenticate via a **repo-local credential helper** that reads `GITHUB_PAT_AIOS` from
`~/.dev.vars` at push time (token never in argv/output). `bin/deploy` **self-heals** the helper before
every push. **Plain `git push origin main --follow-tags` works from any headless agent shell — never
report it as broken.** SSH is NOT on GitHub (only gitlab, the retired pre-scrub lineage — do not push it).

## 5. Multi-session deploy safety
With per-session worktree isolation ([[design-decisions]], `src/worktrees.js`), an isolated agent session
edits its own worktree+branch and **can't** deploy the canonical checkout: `bin/deploy` refuses from a
linked worktree, isolated launches carry `AIOS_NO_DEPLOY=1` (a speed-bump, not a sandbox), and a
`store.js` boot guard refuses to open the canonical 11 GB DB from a worktree. Integration to `main` is
therefore the deliberate seam where parallel work converges — the subject of the autonomous pipeline.

## 6. 🔵 Autonomous integrate-&-deploy (forthcoming)
Goal: **any agent session ships its branch to `main` without a human doing the merge**, the human gate
replaced by a strict procedure + a **multi-agent adversarial check pipeline**, with **rollback** as the
mandatory safety net. Built as a **durable state machine** (survives the self-deploy restart via fencing
+ boot recovery), MVP-first — *deterministic gates before AI reviewers, safe before smart*. Full design,
stages, tables, and the 7-step build order: **[`docs/specs/autonomous-deploy-plan.md`](../specs/autonomous-deploy-plan.md)**.

## Quick reference
- Deploy: `bin/deploy [patch|minor|major|X.Y.Z]` · Stable release: `bin/release [level]`
- Version now: `curl -sS http://127.0.0.1:8793/api/version` → `{version, channel}`
- Health: `curl -sS http://127.0.0.1:8793/healthz`
- Restart: `launchctl kickstart -k gui/$(id -u)/ai.aios.server`
