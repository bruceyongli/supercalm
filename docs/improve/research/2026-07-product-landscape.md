# Research digest — product/OSS landscape (2026-07 sweep)

**Strategic headline:** the "watch your agents from anywhere" layer is COMMODITIZING — Claude Code ships
web + iOS + Remote Control natively; thin orchestrators died (Terragon 2/2026, vibe-kanban sunsetting,
Omnara archived — their stated reason: CLI-wrapper churn treadmill, a warning for detect.js scraping).
**Nobody ships our differentiator: a skeptical, evidence-based supervisor that learns the operator.**
Closest partials: Devin Knowledge (approved entries, per-repo/global scope, staleness warnings),
Sculptor Suggestions (background rule-audit chips), Jules critic (pre-surface adversarial review).
Build on the supervisor; treat remote-viewing as table stakes.

## Top steals (ranked for single-operator self-hosted)
1. **Worktree-per-session isolation + merge-back** — claude-squad/Conductor/vibe-kanban/CodeLayer all
   converged on it; directly fixes our documented multi-agent fix-relay thrash. Impact L / effort M.
2. **Operator diff review with inline comments → agent** (vibe-kanban): per-session diff tab,
   tap-a-hunk composes `file:line — comment` into sendText(). Phone-first review loop. L/M.
3. **ACP sidecar for structured detection** (Zed's Agent Client Protocol; JetBrains/Neovim adopted;
   Claude Code adapter exists): protocol-level waiting/permission events replace regex screen-scraping
   where supported; scrape stays fallback. Reliability compounds into queue/push/supervisor. L/L.
4. **Doctrine v2** — Devin's hygiene (per-project vs global scope, pinned tier, staleness re-approval
   sweep) + Sculptor's doctrine-as-AUDIT (a cheap pass scoring each evidence bundle for rule violations
   — steering AND enforcement from one rule store; converges with TRACE paper). M-H/S-M.
5. **Fleet heartbeat digest with OK-suppression** (OpenClaw): periodic cheap-model sweep → silent when
   fine, ONE digest when not ("2 sessions idle 3h; hold on aios-42 needs a prod decision"); optional
   Telegram delivery = off-tailnet channel. Complements the Attention Governor. M/S.

## Runners-up / quick wins
- **Loop detection** (AgentOps): n-gram recurrence over existing stabilized-snapshot hashes → category
  `looping` + supervisor stand-down. ~1 day; we've been bitten twice. DO EARLY.
- **Supervisor-judged best-of-N** (Codex cloud attempts): 2-3 worktree attempts, supervisor ranks
  against acceptance criteria — we uniquely have the judge.
- **Pre-notification critique gate** (Jules): verify BEFORE pushing the needs-you notification; one
  bounded auto-handback on confident off_track; operator sees fewer, better "done"s.
- **Plan-review card** (HumanLayer ACE-FCA): stage.js already detects planning; render the plan as a
  reviewable queue card (markdown + approve/revise + voice read-out).
- **Attention-request API** (Omnara): `POST /api/attention` — any script/CI enqueues into the same
  queue/push/voice pipeline. Ten lines, big surface.
- **`aios-status` self-title hook** (VibeTunnel): agent sets its own status line, no LLM call.
- **Voice entity grounding** (Wispr): bias STT with session filenames/branch names.
- **E2E-relay for off-tailnet** (Happy): 1.3k-line encrypted-blob relay pattern, QR pairing.
- **Agent-teams tmux panes** (Claude Code): detect teammate split-panes as child sessions before they
  render as one garbled session. (Compat watch item.)
