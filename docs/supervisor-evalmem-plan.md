# Supervisor eval + decision-memory — design & build plan

Branch: `feat/supervisor-evalmem` (worktree `/Users/host/aios-sup`). Isolated from main; **no deploy**,
no edits to `/Users/host/aios`. Live corpus read **read-only** from `/Users/host/aios/data/aios.db`.
Everything flag-gated (default OFF) and reversible.

## Why
Make the auto-pilot Supervisor answer the operator's questions in the operator's own judgment, learned
from Supercalm's logged decision history — WITHOUT fine-tuning a frontier model first. Order of leverage:
**retrieval > eval+prompt-opt > fine-tune.** This branch builds the first two rungs:
- **Stage 2 (first):** a replay-eval baseline so every later change is measured (no flying blind).
- **Stage 1 (second):** decision-memory RAG behind a flag — inject the operator's most similar past
  decisions into the answer prompt so the supervisor decides like they would.

## Data reality (measured 2026-06-17, live corpus)
- `decisions`: 3,009 total; **437 answered** (have `response` = operator's actual answer).
  - by category (answered): `review` 311, `decision` 104, `action` 22. Genuine signal = decision+action (~126).
  - `response_source`: text 356, text+attachments 75, codex 5, supervisor 1, voice/auto 0.
  - length: 243 are 200+ chars (substantive), 107 medium, 87 short.
- Growth ~**40 answered/day** (15–72) → corpus compounds; favor self-refreshing methods.
- `supervisor_reviews`: 506 (a second labeled set: verdict+score). `messages`: 5,962. `sessions`: 78.
- Infra: vanilla node + `node:sqlite`; **no embedding/vector infra**; FTS5 available but we will NOT
  build an index in the live DB (read-only). Retrieval is in-JS keyword/BM25-lite over SELECTed rows.

The corpus encodes operating doctrine, not just "yes": e.g. *"not as good as expected, roll back to the
original flow graph and fix the orphan nodes"*, *"APPROVED — deploy yon-only, do NOT full-restart the
box"*, *"switch DEFAULT MODEL to gpt-5.5, do NOT renew Aliyun now."* `sessions.js` already tags this
data "for future decision-model training."

## Schema we rely on (read-only)
`decisions(id, session_id, project_id, project, tool, model, asked_at, category, summary, question,
ask, responded_at, response, response_source, status)`. The label = `response` (where non-empty).
Situation = `ask` (full distilled) ‖ `question` ‖ `summary`, plus recent `messages` for that session
before `asked_at`.

---

## Stage 2 — replay-eval baseline  (`bin/supervisor-eval.mjs`)
A standalone CLI. **Reads the live DB read-only** (`new DatabaseSync(path, { readOnly:true })`); opens
its own connection; never writes the live corpus.

Selection: answered decisions with `category in ('decision','action')` (review = separate bucket),
`response` non-empty, **excluding noise** (response is a slash-command `^/`, or empty). Most-recent
first, `--limit N` (default 80). De-dupe identical (situation,response).

Per item:
1. Reconstruct the situation the supervisor would have seen: `ask`/`question`/`summary` + the last
   ~20 `messages` for that session with `created_at <= asked_at` (transcript proxy; terminal tail is
   not stored historically; supervision doc is empty for historical sessions — honest baseline).
2. Call the supervisor's **SYS_ANSWER** prompt BLIND (operator `response` withheld) via the fleet
   (`callProxyModel`/`routeForModel`, default model `gemini-pro-agent`, `--model` override).
3. Parse `{action, answer}`. `escalate` is tracked separately (a SAFE non-answer, not a mismatch).
4. **LLM-judge** agreement of supervisor `answer` vs operator `response`: `{verdict: match|partial|
   mismatch, reason}` (strong judge model, default `claude-haiku-4-5`, `--judge` override). Judge is
   told to compare the DECISION/INTENT, not wording.

Output: console table + JSON to `data/eval/baseline-<ts>.json` (gitignored). Metrics: match% /
partial% / mismatch% / escalate%, overall and by category. Small concurrency pool; `--limit`,
`--model`, `--judge`, `--seed` flags. This number is the baseline to beat.

Honesty notes: single-operator data; no doc/terminal for historical items (so this measures the
context-only answer brain — the realistic floor); judge is itself an LLM (report inter-rater caveat).

---

## Stage 1 — decision-memory RAG  (`src/agents/decision_memory.js`, flag default OFF)
Pure, **db-injected** module (no `store` import, no writes) so both the eval and the live supervisor
can use it:
- `retrievePrecedents({ db, queryText, projectId, beforeTs, k })`:
  - SELECT recent answered decisions (`response` non-empty, `category in ('decision','action')`,
    not `^/`), bounded (e.g. last 500), `asked_at < beforeTs` when given (eval: prevents temporal
    leakage; exclude the target row).
  - score in JS: BM25-lite over tokenized `ask`/`question`/`summary` vs `queryText`; +boost same
    `projectId`; recency tiebreak. Return top `k` (default 3).
- `formatPrecedents(rows)`: compact block —
  `OPERATOR_PRECEDENTS (how the operator decided in similar past situations):` then per row
  `• [project] <situation ≤180c> → DECIDED: <response ≤220c>`.

Wire into `supervisor.js runAnswer` behind `cfg.decision_memory` (default false in `meta.defaults`;
env `AIOS_SUPERVISOR_DECISION_MEMORY` override). When on, prepend the precedents block to the
SYS_ANSWER user content; `SYS_ANSWER` gets one line: *"Prefer the operator's demonstrated precedents
when they apply; they outrank generic best practice."* In production the supervisor passes
`store.js`'s `db`; in the eval we pass the live read-only db.

Eval lift: `bin/supervisor-eval.mjs --memory` runs the same set WITH retrieval (precedents filtered to
`asked_at < target.asked_at`, target excluded) and reports match% delta vs baseline. That delta is the
evidence for turning the flag on.

## Files (all under /Users/host/aios-sup)
- `docs/supervisor-evalmem-plan.md` (this file)
- `bin/supervisor-eval.mjs` (Stage 2; reusable for Stage 1 lift)
- `src/agents/decision_memory.js` (Stage 1 retrieval; db-injected, no writes)
- `src/agents/supervisor.js` (wire decision-memory into runAnswer behind the flag + meta default)
- `.gitignore` already ignores `data/`; eval JSON lands there.

## Guardrails
No edits to `/Users/host/aios`; no `bin/deploy`; live DB opened read-only; flag default OFF; all changes
on `feat/supervisor-evalmem`; commit per milestone; report to coordinator (`s_41172b6b2d`) after each.

## Milestones
1. Plan committed → report.  2. Stage 2 baseline runs + number → commit + report.
3. Stage 1 RAG + lift number → commit + report.
