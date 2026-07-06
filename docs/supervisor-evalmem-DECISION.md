# Decision-memory for the Supervisor — ship/no-ship

**Recommendation (one line):** **SHIP as opt-in** — keep `cfg.decision_memory` (default **OFF**),
green-light operator dogfooding on a few sessions, and add a **precedent-confidence threshold** before
any default-on. The matched-pairs lift is real (net **+8** pairwise, **−13pts** escalation, **+11.8pts**
match-or-partial) and the 3 regressions are mild and fixable. Do **not** default-on yet; do **not** no-ship.

_Branch `feat/supervisor-evalmem` (worktree). Nothing deployed, main untouched, live corpus read-only,
flag default OFF._

## Evidence — matched-pairs (same 76 decisions, both arms, leakage-guarded, temp 0)

N=76 valid pairs (of 97 genuine `decision`+`action`; 14 offtopic + 8 transient model/judge errors
excluded), `answer=gemini-pro-agent`, `judge=claude-haiku-4-5`, this task's 2 sessions excluded.

| metric | baseline | memory | Δ |
|---|---|---|---|
| **strict match** | 11.8% (9) | **17.1% (13)** | **+5.3pts** |
| match + partial | 17.1% (13) | **28.9% (22)** | **+11.8pts** |
| escalate (declined) | 53.9% (41) | 40.8% (31) | **−13.2pts** |

**Pairwise:** memory strictly better on **11**, worse on **3**, tied on 62 → **net +8**.
**McNemar (strict match):** gains c=7 vs regressions b=3.
Concrete wins: baseline *escalated*, memory produced the operator's actual call — "borrow LobeHub's
UI/code, build a local agent OS", "yes to both", "per-conversation model", "continue testing".
(Full table + examples: `docs/supervisor-evalmem-results.md`; reproduce with `bin/supervisor-eval.mjs --pairs`.)

## Failure mode — the 3 strict regressions (root cause)

All three share one cause: **the retriever injects its top-k by raw BM25 with no confidence or intent
gate**, so a weak/tangential/terse precedent can mislead the answer.

1. **#1409 [proxy] — "go ahead" → escalated.** The ask was approval to edit an out-of-scope file
   (`~/proxy/claude`). BM25 matched on "API usage / caching / config" and pulled a *cross-project*
   cost-optimization precedent (and two "confirm-direction" asks) — none about approving a scoped
   edit. With only off-intent precedents, memory stayed cautious and escalated. **Wrong-intent,
   cross-project match.** (Arguably a *safe* regression — escalating an off-limits-file edit is defensible.)
2. **#767 [share] — match → partial.** Same-project, same-day precedents were retrieved, but they were
   *tangential* (API billing/quota) and slightly pulled focus; memory's answer was near-identical to
   baseline's, scored one notch lower. **Near-tie / tangential same-day precedent + judge variance** —
   low severity.
3. **#20 [share] — full confirmation → terse "continue".** A prior instance of the *same recurring*
   "confirm the direction" question — where the operator once answered just "continue" — ranked #1 and
   memory parroted it, while the genuinely-best precedent (the same decision, fuller answer) ranked #3
   at a low score. **Over-copying a terse precedent; ranking put form over relevance.** Clearest real miss.

No regression turned a correct answer into a *contradiction* (2 of 3 are match→partial; 1 is a safe
escalate). The downside is "slightly less complete / over-cautious," not "wrong direction."

## Mitigation (one, concrete)

**Precedent-confidence threshold + pool hygiene.** Inject a precedent only when its BM25 score clears a
calibrated bar (and prefer same-project); below the bar, inject **nothing** so memory falls back to
baseline behavior (no downside). Pair it with a small hygiene filter on the precedent pool: drop
non-committal/terse responses ("continue", "ask again") and secret-looking strings (tokens) from being
used as precedents. This directly removes all three regressions — #1409's weak cross-project match and
#20's terse precedent would no longer fire — while preserving the strong-match wins. (Natural follow-up:
a second-pass relevance/intent check via embeddings or a cheap LLM rerank.)

## Safe rollout (flag stays OFF until each gate passes)

1. **Merge behind the flag** (default OFF) when the operator reviews the branch. No behavior change for
   anyone until explicitly enabled.
2. **Dogfood**: operator flips `cfg.decision_memory` ON for 2–3 active sessions and watches the
   Supervisor activity feed (every answer is visible + editable before/after send).
3. **Capture the override flywheel**: when the operator edits/replaces a supervisor answer, persist the
   (proposed → corrected) delta as new labeled data — it's both future eval signal and the calibration
   set for the confidence threshold.
4. **Add the confidence threshold** (mitigation above), calibrated on the override data; re-run
   `--pairs` and confirm lift holds while regressions drop toward zero.
5. **Consider default-on per-project** only after a clean matched-pairs run with the threshold in place.

## Status
`cfg.decision_memory` default **OFF**. Capability is built, flag-gated, reversible, and evidenced.
Decision to enable belongs to the operator.
