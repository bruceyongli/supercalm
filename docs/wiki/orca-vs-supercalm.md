# Orca vs Supercalm — competitive position (2026-08)

**TL;DR:** [Orca](https://github.com/stablyai/orca) (Stably AI, YC W22, MIT, ~43k stars in 5 months) is the best *cockpit* in the CLI-agent category — Electron + native mobile, WebGL terminals, 14 per-CLI hook adapters, deep VCS integrations, disciplined engineering (0.74 test ratio, 28 CI workflows). Verified by full-clone code read (2.74M lines): it contains **zero first-party LLM calls, no supervision, no auto-answer, no verification**, and its "fan out five agents, merge the winner" README has no code behind it (no fan-out primitive, no scoring, no merge). All judgment is outsourced to the user's own coordinator agent and tokens.

**Position:** don't chase their cockpit (editor/browser/VCS UIs/terminals — their funded home turf). Own the layer above as an *interoperable, measured* supervision product: "wake up to a reviewed queue of small, safely-landed changes — with the evidence." ICP: solo founders/tiny teams on Claude Code/Codex + web apps with reversible deploys.

**Plan (post-adversarial-review, gpt-5.6-sol + gpt-5.6-terra):** C0 design partners + supervision safety baselines + injection threat model → C1 one golden macOS install with first-trusted-value <10 min → C2 measured supervisory loop (evidence packets, ≥60% recommendation acceptance gate) → C3 generic runner-hook protocol + GitHub-checks surface (supervise sessions from any cockpit, honest Orca-sidecar spike) → C4 earned autonomy widening; judged fan-out only if partner demand + blind benchmark beats trivial baselines. Business kill/continue tripwires primary; Orca release watch secondary.

Full annex: `docs/improve/research/2026-08-orca-vs-supercalm.md` (+ raw fleet critiques in `critiques/`, rendered report `orca-vs-supercalm.html`).
