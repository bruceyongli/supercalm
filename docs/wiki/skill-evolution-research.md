# Skill-evolution research → how Supercalm learns

The research basis for Supercalm's self-improvement work (the Lessons library + the Supervisor's
self-improving playbook, deep-verify, and verify-learning). Captured here so it's part of the
served knowledge base, not just an agent's private memory. Reviewed 2026-06-19/20.

## The papers (verified)

| Work | arXiv | Mechanism (1 line) | Headline |
|---|---|---|---|
| **SkillEvolver** | [2605.10500](https://arxiv.org/abs/2605.10500) | A meta-skill authors → deploys → **refines** skills (prose+code, no weights); refinement is **deployment-grounded**, not self-reflection | 56.9% vs 43.6% human-curated (SkillsBench) |
| **SkillOpt** (MSR) | [2605.23904](https://arxiv.org/abs/2605.23904) | Frozen agent; optimizer turns scored rollouts into **bounded edits on one `skill.md`, kept only if a held-out score rises** — trains skill docs FOR Claude Code / Codex harnesses | +18.6 Claude Code, +21.8 Codex |
| **EmbodiSkill** | [2605.10332](https://arxiv.org/abs/2605.10332) | Training-free, frozen-executor NL skills; on failure **separates skill-fault (fix the guidance) from execution-lapse (the agent didn't follow valid guidance — don't change it)** | 93.28% ALFWorld, +31.58 vs no-skills |
| **ACE** | [2510.04618](https://arxiv.org/abs/2510.04618) | Context as an **evolving playbook**, curated by incremental **deltas** (avoids context collapse / brevity bias) | +10.6% agents |
| **AWM** | [2409.07429](https://arxiv.org/abs/2409.07429) | Induce reusable **workflows** from past traces, inject forward | +51% rel WebArena |
| **SWE-Exp** | [2507.23361](https://arxiv.org/abs/2507.23361) | Distil lessons from **successes AND dead-ends** into an experience bank | 73% SWE-bench Verified |
| **TroVE** | [2401.12869](https://arxiv.org/abs/2401.12869) | **Grow + trim** a *verified* toolbox | 79–98% smaller |
| **Voyager** | [2305.16291](https://arxiv.org/abs/2305.16291) | Executable, retrievable skill library | 15× faster |

**"EmbodiSkill" is real and relevant** — despite the name it is a *training-free NL-skill reflection*
framework (ALFWorld is just the testbed), not robotics control. Genuine robotics skill-learning (VLA,
world-models — OpenVLA, DreamerV3, Eureka) does **not** transfer to a token-budget software agent.

## The key insight

These papers fight to *obtain* a deployment reward signal. **Supercalm already has it** — the Supervisor's
verdicts, the agents' tests, git diffs, and the operator's own decisions. So Supercalm can do
deployment-grounded skill refinement and policy optimization cheaply, where the papers need elaborate
setups. SkillEvolver runs on the Claude Agent SDK + tmux; SkillOpt optimizes docs *for Claude Code /
Codex* — Supercalm is nearly their reference platform.

## How Supercalm implements these (paper → feature → status)

| Idea | Supercalm feature | Where | Status |
|---|---|---|---|
| Deployment-grounded skill library (SkillEvolver / AWM / TroVE / Voyager) | **Lessons library** — distil a failure-aware lesson per session close, success-gated `skill-fix` promoted + served over the wiki MCP + injected at Preflight | `src/lessons.js` | shipped (per-project, default OFF) |
| skill-fix vs execution-lapse (EmbodiSkill) | the Lessons distiller classifies `skill-fix` (new knowledge) vs `adherence` (the agent ignored existing guidance → NOT a lesson); the Supervisor routes doc-update (skill) vs grill/keep-working (enforce) | `src/lessons.js`, `src/agents/supervisor.js` | shipped |
| Optimize the policy on real ground truth (SkillOpt / ACE) | **Playbook optimizer** — the answer rubric is a versioned playbook; `bin/supervisor-optimize.mjs` proposes bounded edits, scores on real `decisions.response`, keeps only if held-out match beats baseline, human-gated activation | `src/agents/playbook.js`, `bin/supervisor-optimize.mjs` | shipped; **v2 activated** (+11.8pts match-or-partial, escalate 56%→33%) |
| Anchor on ground truth, not prose | **deep-verify** (the completion gate reads the repo's real definition-of-done and demands per-gate evidence), **fact-check on re-grills** (refute hallucinated blockers from git ground truth), **#1 visual proof** (no UI sign-off without a render) | `src/agents/supervisor.js` | shipped |
| Memory of what's proven (scope-aware) | **verification ledger** — trust settled, unchanged, solidly-proven criteria; re-check only what's new/changed/weak (model judges relevance+validity, not a timer) | `src/agents/verify_ledger.js` | shipped |
| Learn the failure taxonomy | **verify-labels** — re-open events classified `fake_done / untested / excuse / partial / new_issue`; injected back as a per-project watch-list; **evidence snapshots** persisted to later optimize SYS_VERIFY by replay | `src/agents/verify_labels.js`, `verify_snapshots.js` | shipped (corpus fills via re-opens) |

## Deferred (and why)

Full SkillOpt on `SYS_VERIFY` (optimize the verify rubric like the answer rubric) needs (a) the
verify-label corpus to grow and (b) the evidence-snapshot replay substrate — now in place
(`verify_snapshots`). Next: a verify-mode optimizer that replays each snapshot through a candidate
rubric and scores it against the label (false_complete vs correct).

See also the agent's roadmap notes; the live design lives in `CLAUDE.md` (Supervisor section).
