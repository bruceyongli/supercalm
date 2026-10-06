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
Launch adjustments live in `src/claude_launch.js`; the shared boot/provider configuration is unchanged.

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

### Tall native composer incident (2026-10-06)

Morph's live composer held a 33-line unsent request. Readiness inspected only 24 lines, missed its
prompt, and treated the permissions footer as permission to paste into an active input. Current
Claude Ctrl-U deletes to the start of the logical line rather than clearing the full buffer. New
questions consequently mixed into the retained request. Four later failed deliveries recorded zero
Enter attempts; the screenshot's older Anthropic 429 was a separate upstream response failure.

Claude operator sends now inspect a bounded 512-line scrollback plus the current pane, with up to
768 lines of composer verification. Unknown composer layouts cannot fall through to active-agent
pasting. A blank first logical line is not proof of an empty multiline input. Retrying the same
complete draft uses Enter only; a different explicit Story request uses the existing replacement
handshake. Ctrl-S stashes the full previous draft exactly once and the sender waits for a confirmed
empty composer before pasting. It never interrupts background work, restores an old stash into an
empty input, or mixes a new request into a draft whose clear could not be confirmed. Displaced text
is also kept in durable composer history if submission of the new request subsequently fails.
[Native editing and stash contract](https://code.claude.com/docs/en/interactive-mode#keyboard-shortcuts).

`claude_composer` pins the pure readiness/clear behavior. The private-tmux `/input` driven test
reproduces a 33-line composer cropped by a 30-row phone viewport and proves: initial pending-draft
409 without keys; one full stash; replacement 200 delivering ONLY the new question; a duplicate
HTTP retry delivers nothing again; the next send does not restore the stash. It also checks
same-long-draft Enter-only retry, an ignored/remapped stash (no paste or Enter), failed-submit
history preservation, and the existing native queue receipt. Codex keeps its original capture,
Ctrl-U, readiness and submit timing/retry behavior. No live project request is resent by the test.

The first live follow-up exposed an omitted state: stashing really cleared the draft, but Claude
displayed an arbitrary DIM suggested prompt and left dozens of blank rows below its footer. The
plain capture treated the suggestion as typed text; the short readiness window missed the composer
above the padding. Retrying then toggled the old stash back into the prompt. Claude captures now
retain ANSI style evidence (`capture-pane -e`), normalize only dim spans inside the live composer,
and trim blank terminal padding before any input/clear verification. Identical non-dim operator
text remains a draft; dim report text outside the composer and RGB color payloads remain intact.
The private-tmux regression now combines the tall old draft, arbitrary dim suggestion, top-positioned
short input and bottom padding, plus a second clean send without restoring the old stash. An empty
ghost composer must receive no stash key. On the operator's explicit resend request, the real Morph
`/input` handler acknowledged one complete question via `claude-native-input`, with one Enter and
one matching native user record; the old unsent text was not submitted with it.

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

## Follow-up audit: false activity and attention (2026-10-06)

Friends `s_2276bb116c` last received a real request and report on September 18. On October 6, the
poller instead recorded waiting → working → waiting about every 30 minutes, with roughly ten seconds
in each false working interval. Re-extracted old reports contained `Auto-updating…`. Adding only that
maintenance line reproduced the old snapshot-hash transition. The deployed version was 0.3.339; the
flaps already existed before it. This was a remaining detection path, not evidence of a merge rollback.

Claude monitoring now separates the viewport signature (still useful to input-delivery diagnostics)
from native conversation activity. It reads at most 256KiB of complete newly appended JSONL records,
retains a bounded identity/signature cache, and ignores file mtime, metadata, replays, sidechains and
foreign UUIDs. A real request/tool/result/assistant record or changed live selector advances activity.
First hydration is observation, not fresh work. Native unfinished turns remain working even when a
stale previous completion timer is still visible. CLI maintenance, resizing, prompt suggestions,
remote-control chrome and unsent drafts do not refresh activity.

For a proven idle, completed legacy session, its initial native snapshot reconciles the activity clock
against durable operator inputs and meaningful lifecycle events. This repairs the false recency without
deleting messages, changing read/dismissal decisions, or resending anything. Claude home/voice recency
uses that real work clock, so recent timestamps on legacy re-extracted reports cannot revive old work.

### Coverage matrix

| Aspect | Audit result and protection | Evidence / regression coverage |
|---|---|---|
| Activity and ordering | Fixed viewport changes and file-mtime updates being mistaken for work. Old idle clocks reconcile conservatively from native + durable intent. | `claude_activity`, `claude_activity_monitor`; read-only Friends native/pane/DB comparison |
| Foreground state | Quoted spinner/approval/task-count wording above an idle composer no longer changes state. Native unfinished turns outrank a stale previous done line, even during a partial JSONL write. Blank padded rows do not hide the footer. | `claude_activity`, `claude_lifecycle`, `detect_background` |
| Background work | Retained real shells/subagents/monitors/workflows/teammates and pending one-shot wakeups. Known standalone services/recurring schedules alone do not hide final reports. Quiet real work is not parked merely for being quiet. An explicit current zero outranks an older count. | `claude_lifecycle`; Morph still has two native shells and stays working |
| Passive notifications | Fixed `idle_prompt` and repeated completion refreshing age. Delayed permission/elicitation reminder notifications cannot create a second episode for the same gate. Informational/future notifications are not completions. | Real hook-script → HTTP-handler trace in `claude_hooks` |
| Source/report identity | Durable source keys include the bound conversation and request/turn/gate boundary. Cropping, raw-versus-curated wording, replay and hook-versus-terminal projection cannot reopen the same report. A genuinely new report can appear without an observed working interval. | `claude_activity`, `claude_activity_monitor`, `claude_hooks` |
| Dismissal and concurrency | Fixed late summary formatting undoing Dismiss. A formatter for an older report cannot overwrite a newer episode. Existing reports/read/dismissal records are retained. | `claude_hooks` holds an actual summary HTTP response until after dismissal |
| Permissions | Preserve actual tool name and bounded command/file context, not an empty question or the entire possibly sensitive tool input. Same `tool_use_id` identifies hook and terminal projections. Existing autonomy levels are not escalated. | `claude_hooks`, `claude_lifecycle`, `feedback_survey_gate` |
| AskUserQuestion | Verified single/multi-question options, multi-select, custom text, final Submit, updatedInput/native answers, cancellation, and stale/quoted-menu safety through existing shared input/Story controls. Unknown layouts do not receive speculative keys. | `claude_story_adapter`, `agent_submit`, `story_terminal_question_browser`, `claude_story_adapter_browser` |
| MCP elicitation | URL-mode requests retain their actionable URL and native `elicitation_id`; accept/decline/cancel return control to the agent, rather than leaving an unanswered ghost question. Complex forms still use the actual terminal; no invented automatic answer API. | `claude_hooks`, `claude_lifecycle`; official hook schema |
| Input and native queue | Verified queue admission clears the composer without waiting for model consumption. Fresh complete exact-UUID receipts only; now rejects automation enqueues with matching text as receipts. No send-now/interrupt is added. | `claude_input_receipt`, `session_input_delivery`, `ui_attention_options_browser` |
| Story reports/tools/plans | Verified explicit `end_turn`, API-block replay, intermediate `tool_use`/`pause_turn`, correlated failures, task checklists, helper handback, operator queue attribution and conversation paging. Live status extraction is now restricted to the actual Claude status line/footer, not prose or drafts. | `claude_story_adapter`, `story_paging`, `story_rich`, `claude_story_adapter_browser` |
| Native binding and late hooks | Fixed a fresh timestamp from a different native UUID being able to rebind a session. Reject wrong-tool hooks; retain legitimate `/clear` rebinding. Boot replays bounded recent lifecycle state as well as the latest background snapshot, without assigning boot time to old events. | `claude_hooks`, `claude_transcripts`, `claude_lifecycle` |
| Start/resume/isolation | Verified exact UUID resume, context-preserving gates, supported prompt-snapshot capability, deliberate permission tier, launch grace and preserved worktree. Missing history now fails before killing a live pane or using another conversation; relocation searches only the exact UUID. | `claude_hooks`, `claude_transcripts`, `claude_input_receipt`, `external_recovery`, `resume_seed` |
| API/auth/quota failures | All native StopFailure errors mark an unhealthy response; subsequent real submit/Stop or newer successful native progress clears that marker. Existing authentication recovery and quota-fallback routing remain unchanged and never mutate the proxy fleet. | `claude_hooks`, `claude_lifecycle`, `session_errors_anchor`, `launch_autonomy_profile`, auth/usage suites |
| Model/effort/provider config | Installed 2.1.291 `--help` supports low/medium/high/xhigh/max and explicit permission/settings/resume options. Existing inventory discovery and route ownership remain intact; no model/provider/permission config rewritten. | Installed binary probe; model/auth/usage suites in the full run |
| Mobile/desktop UI | Verified native questions reach the input handler; final report/error/answer projection and stable DOM at desktop, tablet and phone widths. Recency behavior changes only for Claude. | `claude_story_adapter_browser`, `ui_attention_options_browser`, `session_recency`, voice recency tests |
| Codex boundary | Its launch/provider configuration, hook precedence, paste/Enter behavior, background hold and recency remain unchanged. Claude-only branches guard shared entry points. | Codex fixtures in lifecycle/hooks/input suites plus full regression run |

### Captured driven test

`claude_activity_monitor` uses a real private tmux server, native JSONL fixture, private SQLite DB,
production session poll/classifier/attention store, and `/api/phone/home`. No live coding session is
sent input. The fake terminal continually changes maintenance chrome and even crops the old report.
The trace proves zero false status transitions, the repaired old work clock, a retained dismissal,
then a real new quiet request and exactly one fresh source-grounded unread report:

```json
{"handler":"real session poll → classify → attention store → GET /api/phone/home","maintenanceRepaints":">20","falseStatusTransitions":0,"legacyClock":"repaired from native record","dismissal":"retained across repaints","newRequest":"working including quiet phase","newReport":"one source-grounded unread","realReport":"The NEW endpoint now works; no further action is required.","noLiveSessionsTouched":true}
```

### Honest limits / remaining findings

The read-only live audit found eight non-exited Claude rows: three still had their bound native files,
and five did not. Searching the native store by those five exact UUIDs found no replacements. Their
AIOS operator messages remain, but the unavailable full native histories cannot be honestly recreated
by selecting a sibling session or silently treating the launch prompt as the entire conversation.

Claude's documented default transcript retention is 30 days, with a silent background deletion sweep.
That is a plausible explanation for old missing files, not a proven deletion audit for these five.
We did not rewrite the machine's retention policy or claim deleted files were recovered. A proper
AIOS-owned live-session archive/backup policy is separate work; extending one CLI's settings alone
does not guarantee another CLI invocation cannot sweep the same native store.
See [native data retention](https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically)
and [cleanupPeriodDays](https://code.claude.com/docs/en/settings-reference#cleanupperioddays).

Native monitoring deliberately bounds reads. A single oversized JSON record, unsupported content
envelope, or missing transcript falls back to typed hooks/live native UI evidence; it is not reported
as newly completed merely because its file changed. Unknown menus remain operator-driven.

Cloud/background-session daemon administration, Claude apps gateway, plugins/mods, native rewind and
remote-control management are not AIOS-owned workflows. They were checked for accidental coupling,
not enabled or reimplemented. No coding session was killed/resumed, no original prompt resent, no
global Claude authentication/settings edited, and no files removed by this audit.
