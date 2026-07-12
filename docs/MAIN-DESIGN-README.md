# Handoff: Supercalm — Desktop Web UI + First-Run Onboarding

## Overview

Full redesign of the Supercalm agent-OS **desktop web app**: a one-time first-run onboarding wizard, a persistent left-nav shell replacing the top button bar and the hidden edge-reveal session menu, and redesigned versions of every screen (Home/triage, Session, Projects, Decisions, Records, Usage, Health, Settings). The phone companion design (separate handoff) is unchanged; this shares its color DNA and read/reply semantics.

**Design evolution**: same terminal DNA, softer and more product-like. JetBrains Mono remains the voice of *data* (session names, paths, models, terminal, values, chips); **IBM Plex Sans** is introduced for *UI copy* (page titles, body text, buttons, helper lines). Softer moves: 13–14px radii everywhere, fewer/lower-contrast borders, real page titles, generous whitespace, no shouting.

## About the Design Files

`Supercalm Desktop.dc.html` is a **working HTML prototype** — a design reference, not production code. Recreate it in the existing Supercalm web app codebase using its established routing and API/session layer. All data is simulated; wire per "Integration contract" below. When this README and the file disagree on a pixel value, the file wins.

Prototype controls (Tweaks): `view` jumps to any screen (`onboarding` | `home` | `session` | …), `serverName`, `showFirstRunHint`.

## Fidelity

High-fidelity for layout, color, type, spacing, and interaction flows. Data content is placeholder. Desktop-only: design min-width ~1240px; below that, serve the phone layout.

---

## Design tokens

Inherits the phone handoff's palette. Deltas / additions:

| Token | Value | Use |
|---|---|---|
| bg/app | `#0a0e14` | main background |
| bg/chrome | `#0c1017` | sidebar, session header, right panel |
| bg/card | `#10151d` (border `#1d2632`) | cards, forms |
| bg/row | `#0d1219` (border `#161d27`) | session rows, stat cells, file rows |
| bg/input | `#0b0f16` (border `#232c38`, focus border `#365a86`) | inputs, selects, segmented controls |
| bg/terminal | `#070a0f` (border `#141a24`) | terminal pane |
| nav active | bg `#121a26` + `inset 2px 0 0 #58a6ff` | sidebar + sub-nav active state |
| segmented active | border `rgba(88,166,255,.55)`, bg `rgba(88,166,255,.08)`, text `#79b8ff` | tool/autonomy/effort/panel tabs |
| primary button | `#238636`, border `#2ea043`, hover `#26963c`, white text | Get started, Sign in, Launch, Add |
| toggle | on `#238636` / off `#232c38`, knob `#e9eef5` 20px | KB, HTTPS serve |

**Type**: Sans = `IBM Plex Sans` 400/500/600 — page titles 19–26/600 (letter-spacing −.01em), body 12.5–14/1.6, buttons 12.5–13.5/600, helper 11–12. Mono = `JetBrains Mono` — wordmark 15–22/800, session names 12.5–14/800, section labels 10.5/700 ls 1.5 uppercase, chips/badges 9.5–10/700–800, terminal 12.5/1.75, values 15–24/800. Floors: nothing below 9px; hit targets ≥ 30px within chrome, ≥ 34px for standalone buttons.

**Radii**: cards/panels 13–14, modals 18, buttons 9–11, inputs 10, chips/pills 999, terminal 13. Spacing: page gutter 32, page max-width 1080 (doc-style pages), card padding 14–18, stack gaps 8–14.

---

## Navigation / IA

**Persistent left sidebar (236px, `#0c1017`)** replaces the top button row *and* the mouse-to-left-edge reveal menu (discoverability fix). Structure top→bottom:

1. Wordmark `Supercalm` + `agent OS` (+ `pin`/`unpin` control in session view) · live counters row (`3 waiting` yellow dot · `1 working` green pulsing dot · `8 live` neutral) — clickable → Inbox.
2. **+ New session** (primary green) → modal · **⌘K jump to…** faux-search row → command palette.
3. Nav: **Inbox** (yellow badge = unanswered needs-you count), **Projects** (inline `+` → Add project).
4. **SESSIONS** section label + up to 7 live session rows — **two-line**: dot + mono name + mini agent chip + `Waiting`/`Working` status word, then task ellipsis. Click → session view; active row gets nav-active treatment.
5. **SYSTEM**: **Decisions** (neutral count badge — review queue, not an alarm), **Records**, **Usage**, **Health** (yellow dot only when issues exist), **Settings**.
6. Footer: server name · proxy status dot · clock.

### Session-view collapse, peek, dock (terminal-space model)

The sidebar stays **docked by default everywhere** — including session view. A `⟨ collapse` control (sidebar header, session view only; also `⌘\`) collapses it to a **56px rail**: `≡` (hover/click) peeks the full sidebar as a fixed overlay — no terminal reflow; mouse-leave closes it — with a `dock` control to restore it. The collapsed state persists across session visits until the user docks it again. Rail contents: `≡`, yellow unanswered-count badge → Inbox, one status-dot button per live session (active = blue ring), `+` new session.

### Command palette (⌘K)

Global `⌘K`/`Ctrl+K` (or the sidebar row) opens a centered palette: fuzzy substring filter over screens (`go`), actions (`action`: New session, Add project, Collapse/Expand right panel, Re-auth CLIs, Replay onboarding), and live sessions (`session`, with task preview). `↑↓` navigate, `⏎` runs, `esc` closes. Selected row = nav-active treatment.

Old top-bar mappings: `+ Session`→sidebar button; `+ Project`→Projects header + nav `+`; `Re-auth`→palette action + Settings → Agents; `Auth`→Settings → Agents & sign-in; Health issues surface as the Health nav dot.

---

## Onboarding (first run only)

Shown when the server has no completed-setup flag. **Hybrid wizard**: welcome → **4 steps** in a fixed left step-rail (done = green ✓, current = blue ring). Steps 1–2 are **required gates**; 3–4 are **optional**. Rail steps are clickable: backward always (visited), and **forward once the sign-in gate is satisfied** — so a user can jump straight to any optional step. As soon as ≥1 credential exists, the rail also shows **▶ Start using Supercalm** ("skip the rest — Settings keeps it all"), which finishes setup immediately; step 4's primary button is the same finish. **First project and first session are NOT wizard steps** — they happen in the app (see Inbox first-run state). Once finished, onboarding never reappears; every step's config lives in Settings.

- **Welcome** — wordmark, "Let's wire up this machine.", DETECTED card (host, server version, listening URL + reachable dot), `Get started →`, "about 3 minutes".
- **1 · Coding agents** — auto-detected rows per CLI: status dot, mono name, version, state chip (`LATEST` green / `0.143.0 AVAILABLE` yellow / not found). One-click **Install** (green, live progress bar + `npm i -g … 34%` caption) and **Update** (ghost → `updating…` pulse). `↻ Re-scan PATH` ghost + `▸ Install another way` disclosure with copyable commands. Gate: installs/updates must not be mid-flight.
- **2 · Sign in** — one auth card per installed CLI: `SIGNED IN`/`NOT SIGNED IN` chip, `Sign in →` opens the CLI's OAuth page, then inline paste field ("Browser opened — approve there, then paste the CODE#STATE") + **Complete** (enabled on input). Signed-in card shows green border + token expiry note. Below, `OR — API KEY` divider + provider card: type select, **base-URL field appears for non-Anthropic types** (required for OpenAI-compatible — Test refuses without it; optional-with-default for OpenRouter), key, **Test & add** → auto-discovers models. **Gate: ≥1 CLI signed in or ≥1 provider.**
- **3 · Voice (optional)** — presets segmented (OpenAI / Groq / Local Kokoro / Custom) prefill base URL + STT/TTS models + voice; key field; **Test endpoint** → `✓ STT 380ms · TTS 210ms`. Test is recommended but not a gate — Continue saves untested (gate note says so); Skip leaves voice unconfigured. Footnote covers SPARK_IP precedence + local servers.
- **4 · Access anywhere (optional)** — tailscaled detection row (running · tailnet · machine); **Serve over HTTPS** toggle → reveals copyable `https://host.your-tailnet.ts.net` + QR (phone: install Tailscale → same tailnet → open URL → Add to Home Screen = phone app). `▸ Don't have Tailscale?` disclosure with install command. Primary button = **Start using Supercalm** (no gate — serving is optional) → finishes setup, lands on the empty Inbox with toast "Setup complete — this box is yours".

### First-run app state (after setup)

The app opens **empty**: counters at 0, no needs-you cards, no sessions. The Inbox shows a green-dashed hero: `✓ setup complete — this box is yours` + "Start your first session: pick a repo — or type a new path and the project is created on the spot — give the agent a task, and walk away." + **▶ Start first session** (opens the New-session modal) + a `⌘K · Settings` footnote. Projects page shows a matching empty state. Launching the first session → session view + dismissible hint bar; Inbox then shows `All clear` + the one live session; sidebar/rail/counters reflect it. Demo screens (Records/Usage/Health/Decisions) keep placeholder data in the prototype.

## Screens

- **Inbox (triage)** — "Needs you" title + count badge + **Voice** button (green outline; toggles red pulsing `● listening…`). Needs-you cards: 3px badge-colored left strip inset, badge chip (ACTION red / DECISION yellow / REVIEW green), agent chip (Claude `#d9924e` / Codex `#9aa7b8`), mono session name, model·mode, time; mono message text 14/1.62. **Answer without leaving the Inbox**: messages carrying options render full-width decision buttons (first = green fill, rest = ghost; labels carry the TUI key, e.g. `y — top up + delete`); `Reply` expands an inline textarea + send circle in-card. Answering/replying stamps `✓ answered "y" — session resumed`, fades the card to 55%, and decrements the Inbox badge — mirrors the phone's read/answer semantics. Unanswered cards keep the hint (`y / n answers this`). Dashed stale strip. SESSIONS rows: dot, agent chip, mono name, task ellipsis, status word, age — whole row opens the session. `▸ Recent · exited (12)` collapsed group with working `resume`.
### Story view (non-technical session log)

The session log has two modes, toggled by a `☰ story | ⌨ terminal` segmented in the session header (default = story; `defaultLogView` prop). Terminal = the existing raw TUI. **Story view re-renders the same log as a plain-language timeline** for people who don't want to see the coding stuff: sans-serif sentences first, tech demoted to an expandable peek.

Timeline grammar — icon-dot spine + one block per event, **fourteen** event kinds:
- `❯ you` (blue) — operator message, in a quiet bubble
- `○ sys` (dim mono) — lifecycle: session started/resumed/exited (exit code), context compacted, model/mode switches
- `⌕ work` (grey) — a **cluster** of consecutive tool calls, headlined in plain words ("Got oriented in the project"), meta `6 quick look-arounds · 40s`; expandable `▸ N steps` reveals human step lines and, under those, dim mono `$ commands`
- `☑ plan` (blue) — plan/todo created or updated, items as chips
- `· note` (dim) — agent's own narration while working
- `⑂ sub` (indented) — a sub-agent/sidechain: one indented block with its own summary
- `✎ edit` (orange) — changes made, with file chips (`styles.css +7`)
- `✗ fail` (red) — error/failed command/test failure, with the recovery in the body; meta turns green (`recovered`) once healed
- `✓ check` (green) — verification: tests/screenshots, pass/fail; screenshots render as a thumbnail (click to enlarge)
- `⬆ ship` (teal) — milestone: commit/merge/deploy
- `⌾ web` (grey) — web lookups/fetches, domains named
- `≡ report` (light) — the agent's answer/summary
- `? ask` (yellow, tinted card) — decision needed: question + the same full-width answer buttons as the Inbox; answering stamps ✓ and resumes
- `⏹ stop` (yellow) — operator interrupt (esc/^C); **gap divider** (thin rule + mono label) marks idle stretches ("quiet since 4:12 AM — parked until you answer")

Header strip: "What happened, in plain language" + rollup (`38 min active · 6 files touched · tests green · 1 question for you`). Composer and right panel work identically in both modes; quick-keys row is terminal-only.

**Derivation from the real logs** (both formats verified against `data/`):
- *Codex rollout JSONL*: `event_msg/agent_message` `phase:"commentary"` → `note`; `phase:"final"` → `report`; `event_msg/user_message` → `you`; `session_meta`/`turn_context`/`task_started` → `sys`; consecutive `response_item/function_call`(+outputs) → one `work` cluster (verb from command class: git/rg/cat→"looked around", apply_patch→`edit`, test/build→`check`, deploy/git merge→`ship`, curl/fetch→`web`, update_plan→`plan`; exit≠0 → `fail`); `reasoning` items → cluster duration only; `token_count` → header rollup; turn aborts → `stop`.
- *Claude project JSONL*: `assistant` `tool_use` → cluster steps — **use `input.description`** ("Show sessions and supervisors schema") as the human line, `input.command` as the mono peek; tool name routes the kind (Read/Grep/Glob→`work`, Edit/Write→`edit`, Bash test/build→`check`, WebFetch/WebSearch→`web`, TodoWrite→`plan`, Task→`sub`, AskUserQuestion→`ask` with its options); `text` blocks → `note`/`report`; `thinking` → duration only; `toolUseResult.stderr`/`is_error` → `fail`; image tool results → `check` thumbnail; `ai-title` → session title; `isSidechain` → `sub` indent; `mode`/`permission-mode`/`file-history-snapshot`/`attachment` (skill/agent listings, task reminders) → hidden (no story value); interrupts ("[Request interrupted…]") → `stop`.
- Cluster boundary: same event class within 90s merges; class change or >90s gap starts a new block; idle >10 min renders the gap divider.

- **Session** — header (`←`, agent chip, mono name, URL faint-ellipsized, model·mode pill, status word, **Stop** ghost, **Kill** red outline with **two-tap arm**: `Confirm kill` pulsing, auto-disarm 2.6s). Body = terminal column + right panel. **The right panel is collapsible and resizable**: `›` in the tab row collapses it to a 44px vertical strip (rotated mono tab labels; clicking one re-opens straight to that tab, `‹` expands); a 7px drag handle on its left edge is **free drag — no min/max clamp** (persist as a fraction of available width, matching the shipped `usage-resizer` behavior). Rail + collapsed panel returns ~530px to the terminal. Terminal (`#070a0f`): transcript, supervisor blockquote card, `●  Bash(...)` tool lines with `└` sub-lines, `✳ Nesting…` status, `❯` prompt with blinking teal cursor + branch tag; footer strip (`▶▶ bypass permissions on (shift+tab to cycle)` · `esc to interrupt` · right: `100% context used` yellow). Quick-key chips (Enter Esc ↑ ↓ Tab 1 2 3 y n ^C) send literal keys to the TUI. Composer card: 3-row borderless textarea, placeholder "Ask anything, paste or attach files/images…" ("sends to the session without stealing the terminal" — same no-focus-steal rule as phone); below it one quiet mono text-row: bare inline selects `full ▾ · max ▾ · model ▾ · off ▾` (autonomy/effort/model/orchestration — no borders/boxes, `title` tooltips carry the names), `+` attach glyph, then right-aligned `⌘⏎ send · ⏎ newline` + dim `◉` mic glyph. No send button — `⌘⏎` sends. Right panel tabs **Graph / Supervisor / Knowledge / Usage**: Supervisor tab has **no repeated header or segmented switch** — one compact row: `co-pilot ▾` bare mode select (blue) · `model gpt-5.5 · chain ▸` · green `on server` dot · `Run check` ghost; one-line mode description under it, then TASK CARD (status chip, title, `v7`, ☑ criteria, `+ New task`/`+ criterion`/`Edit goal`/`✓ Done`/`Abandon`), LEARNING chips (17 TO REVIEW / 16 LIVE), POLICY DECISION feed card. Knowledge = CONTEXT.md card (`inject into launches`, preview, `Generate from repo`/`Save`) + agent-written files list (`doc` chips). Usage = quota bars (yellow, caption `87% · resets 23h`) + 2×2 session stats (money yellow) . Graph = dashed placeholder reusing desktop graph component.
- **Projects** — header + `+ Add project`; explainer line; rows: mono name + live-session count, path, graph chip (`● graph ready` teal / `○ not indexed` neutral), freshness (head-changed yellow), counts, `index` ghost, `+ session` green.
- **Decisions** — **Doctrine | Messages** segmented (Messages = supervisor⇄builder log, reuses Records filtered); doctrine intro, `✳ Have the supervisor review these` + `Apply 13 suggestions`; rule cards: yellow left strip, WHEN-trigger (mono yellow caps), rule (sans 13.5), `apply ▸` line (mono muted), `✓ Approve` / `Edit` / `✕ Reject` + suggestion/audit/project chips + learned-age · evidence session link. Deciding fades the card and stamps the outcome.
- **Records** — filter card (project/session/tool/model/source/direction selects, from/to dates, substring search, Clear, Export JSON) + record cards (time, model chip, session, direction, session-id link, 1–3 mono preview lines).
- **Usage** — 3 stat cards (est. cost yellow, quota bar, top project) + 4 mini stats + BY MODEL table + collapsed raw-log strip.
- **Health** — version/live-sessions/projects cards, yellow issue strip with `re-index`, AUTH table (mode + per-CLI logged-in ages), PROJECT GRAPHS table (status ready-green/missing-red, freshness, indexed, counts).
- **Settings** — sticky sub-nav: **Agents & sign-in** (Session-auth-path card first: PROXY mode chip, reachable dot + URL, `Re-check proxy`, auth-detection-order explainer; then updater card + per-CLI cards with LOGGED IN chip, version, token expiry, `▸ Re-login` disclosure = same paste flow as onboarding), **API providers** (full form: type, name, base URL, models list, key, Test & add), **Voice**, **Remote access**, **Preferences** (real controls: auto-play toggle, voice-rate −/+ stepper 0.5–2.0×, quick-keys toggle) — 1:1 homes for every onboarding step.
- **Modals** — **New session is the single launch surface and embeds project creation**: project select (existing projects + `+ new project`); choosing `new` reveals path, name (auto-suggests from path), and Build-knowledge-base toggle inline — launching creates the project and the session in one step (gate: task + path-when-new). Tool segmented (only credentialed tools enabled), model per tool, autonomy + explainer, effort, orchestration, task + `use an example`. Add project modal (path, name, KB) remains for project-only creation. Centered, 18px radius, scrim `rgba(4,6,10,.72)`, slide-up 220ms.
- **Toast** — bottom-center mono pill, 2.4s: `Sent — session resumed`, `Stop signal sent`, `Session killed`, `Copied`, etc.

## Interactions

- Buttons: hover lightens bg; active `scale(.94–.985)`. Pulses 1–1.4s opacity 1→.3 (working dots, recording, kill-armed, install captions). Sheets/modals/palette: scrim fade 120–180ms + rise 160–220ms. Sidebar peek: fade 150ms, no reflow. No other motion.
- Keyboard: `⌘K` palette everywhere; `⌘\` toggles sidebar collapse in session view; `⌘⏎` sends the composer; `esc` closes palette/modals/peek. (Production: add `j/k` walking + `y/n/1-3` answering on focused Inbox cards.)
- **Entering a session always shows the docked sidebar**; collapse (`⟨ collapse` or `⌘\`) lasts only while you stay in session view — switching sessions via the rail keeps it, navigating away and back resets it.
- Toast: bottom-center; in session view bottom-right so it never covers the composer.
- Composer never steals focus (phone rule holds on desktop).
- Destructive = two-tap arm (Kill). All copy actions confirm via label swap (`copied ✓`) or toast.
- Gating is always explained in-place (gate note text, disabled = `#5c6675` on `#10151d`, locked segments at 45% + toast pointing to Settings).

## Integration contract

Onboarding endpoints: (1) env detect — host/OS/port/version; (2) CLI scan — per tool `{installed, version, latest, registryFeed}`; (3) install/update — streamed progress; (4) OAuth — start-URL per CLI + code-paste completion, token expiry; (5) provider test — validate key (+ base URL for OpenAI-compatible), return model list; (6) voice test — round-trip STT/TTS latency; (7) tailscale — detect daemon/tailnet/machine, toggle serve, return URL. Finishing sets a server-side `setupComplete` flag and lands on the empty Inbox. **Project creation and session launch happen in the app**: session launch `{project | newProjectPath+name+kb, tool, model, autonomy, effort, task}` — creating the project (and kicking off its index job) atomically when a new path is given. Individual step state re-reads from the same endpoints in Settings. Sidebar counters, session rows, and Needs-you reuse the phone contract's live-update channel (websocket) and server-synced read state.

## Files & assets

- `Supercalm Desktop.dc.html` — the prototype (all styles inline; logic class at bottom).
- No images/icons — glyphs are text (`→ ‹ › ▸ ▾ ✓ ✕ ✳ ● ○ ☑ ❯ ◉ ↑ ↻ ▶`); QR is a placeholder (generate a real one from the serve URL). Fonts from Google Fonts: JetBrains Mono 400–800, IBM Plex Sans 400–700.
