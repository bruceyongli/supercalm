# Claude Code CLI compatibility

Checked 2026-10-06 against the installed Claude Code 2.1.291, its native records, and the official
documentation. This is a Supercalm adapter audit, not a request to upgrade the CLI or change Codex.

## Incident and boundary

Morph session `s_3d6718d569` displayed a foreground completion timer with four shells still running.
The prior adapter treated every Stop/Notification as waiting and discarded their metadata. Its Needs
You question also included an unsent operator draft and terminal footer. Native records showed finite
acceptance/wait loops, not merely leftover dev servers.

One input-delivery event separately returned `input-changed` after a repaint. That event alone does
not prove the specific instruction was accepted. The fix requires fresh native evidence, rather than
assuming any disappeared draft was delivered.

Claude changes are tool-scoped. Codex launch arguments, notify precedence, Enter timing/retries and
ten-minute background-server hold retain their existing behavior. No coding session is interrupted,
force-resumed or sent an additional instruction by this audit.

## Reviewed surfaces and implementation

Claude lifecycle fields distinguish foreground response completion from pending background work.
SubagentStop snapshots describe the parent registry; helper output is not a parent report.
StopFailure identifies API errors separately. Supercalm retains bounded snapshots, final text and
typed notifications, ignores informational notifications, and preserves genuine permission/elicitation
attention. [Official hook contract](https://code.claude.com/docs/en/hooks).

| Surface | Supercalm handling |
|---|---|
| Native shell/agent footer | Parse only the live composer/footer; quiet finite work remains working. A missing count is not zero. |
| Stop snapshots | Active jobs and one-shot wakeups keep working. Recognized standalone services and recurring schedules alone do not hide completed reports. |
| Lifecycle persistence | Store bounded metadata in hook events; restore the latest bound-session snapshot on boot. Reject late events before transcript rebinding. |
| Questions and selectors | Project native questions into the existing Story controls; recognize live custom-answer menus, not quotes above a composer. |
| Plan/trust/API-key gates | Navigate the actual highlight. Preserve conversation context and the operator's permission tier. Unknown layouts require operator action. |
| Native system-prompt snapshots | Capability-check `--system-prompt-snapshot off` on Claude resumes with a rebuilt AIOS append prompt. Fresh launches retain the native cache default; unsupported builds receive no new option. |
| Mid-turn human input | Parse human-origin `queued_command` attachments once, preserving original source UUID/time. Do not turn automation into operator requests. |
| Helper reports and new tools | Keep `SubagentHandback.message` as helper output; map Agent/legacy Task, Monitor and Workflow without claiming parent completion. |
| Story boundaries | Retain explicit native completion boundaries, correlated tool results and structured answers from the preceding adapter update. Native API errors are failures, not successful reports. |

Current interactive versions distinguish queue admission from later consumption, and offer a separate
send-now action. Supercalm accepts a proven queued receipt without using send-now, cancelling work,
or waiting for the model to consume it. [Interactive input behavior](https://code.claude.com/docs/en/interactive-mode).

The Claude-only receipt observer starts before our paste and reads at most 256KiB of newly appended,
complete JSONL records. It requires the bound native UUID and full matching text. Old identical
messages, partial writes, sidechains, automation, queue removals and another conversation cannot
acknowledge delivery. A positive queued receipt returns HTTP 200; the existing composer clears it
immediately. Unconfirmed input remains editable. HTTP idempotency prevents retry duplicates.

Claude resume uses the bound UUID with `--resume`, falling back to the old behavior only without a
usable native identity. AIOS `ask` explicitly requests manual/default permissions; `auto` remains
acceptEdits and `full` remains bypass. These are deliberate Supercalm contracts rather than adopting
whatever defaults a new CLI release chooses. [CLI options](https://code.claude.com/docs/en/cli-reference),
[release history](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md).

## Operational limits

Managed lifecycle hooks remain opt-in under `claudeHooks`. Boot refreshes only AIOS-owned settings;
new launches/resumes load all subscriptions. Existing panes benefit from the updated script and native
footer recognition without a forced restart. Do not assume every CLI build hot-reloads an arbitrary
`--settings` file. Unknown service commands are conservatively treated as work; extend service
recognition only with a concrete fixture, not a blanket inactivity timeout.

We did not rewrite CLI plugins, remote-control/cloud behavior, provider auth files, Spark, proxy
configuration, or unrelated native UI features. Transcript parsing/Story rendering remain shared,
but the new lifecycle and receipt semantics apply only to Claude.

## Captured checks and repeatable verification

`test/claude_hooks.test.js` runs the actual hook script into the real HTTP handler with a private DB
and no live tmux panes. Its captured trace verifies foreground Stop + pending work stays working,
idle preserves work, helper completion does not finish the parent, permission creates durable
attention, final assistant text survives, API overload is degraded, and stale rebinding is rejected.
The same test verifies the original Codex completion/submit hooks.

`test/session_input_delivery.test.js` drives a private tmux CLI fixture through the real `/input`
handler. Captured Claude queue result:

```json
{"family":"claude","handler":"POST /api/session/:id/input","native":"queue-operation/enqueue","http":200,"queued":true,"enters":1,"accepted":1,"receipt":"claude-native-queue"}
```

The HTTP retry uses the existing receipt and does not paste again. The same suite drives both Codex
and Claude ignored-first-Enter recovery, concurrent retries, multiline/attachment redraws, and
unconfirmed submissions. Those traces distinguish actual acceptance from composer screenshots.

Additional regression coverage:

- `claude_lifecycle`: quiet finite jobs, leftover services, absent/zero counts, typed notifications,
  failures, wakeups, highlighted/context-preserving gates and quoted-menu safety.
- `claude_input_receipt`: fresh complete matching native records only; exact resume and permission argv.
- `claude_story_adapter`: human queue attribution/deduplication, source timestamps, API errors, helper
  handback, and worker pagination across queued-input round boundaries.
- `ui_attention_options_browser`: iPhone composer clears after a queued 200 acknowledgement with one
  send; existing dictation, uploads, draft/history and Codex async options still work.
- `claude_story_adapter_browser`: native questions, tool failures and final reports at desktop,
  iPad and iPhone widths; stable DOM across unchanged updates.
- `detect_background`, `agent_submit`, `feedback_survey_gate`: retain old Codex submit/background
  behavior and prevent ambient keys on quoted menus.

Run `npm test` before integration; the standard pipeline tests the merged candidate again and releases
only through `bin/deploy`. Confirm public version/health, GitHub main/tag, and the incident session's
native footer against its API status after release. Never edit the canonical main worktree to deploy.
