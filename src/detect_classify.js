import { stripAnsi } from './util.js';

// PURE terminal-pattern classifier — no store/sessions/server imports, so it is unit-testable without
// booting the service. The poll-loop wiring (setClassifier) lives in detect.js, which re-exports this.
//
// Two-layer "waiting for input" detection:
//   1) authoritative hook overrides (claude Notification/Stop, codex notify) — set by hooks.js
//   2) idle + terminal-pattern heuristics (universal; the only signal for agy)
// classify() returns { status, question }.

const IDLE_WAIT_MS = Number(process.env.AIOS_IDLE_WAIT || 4500);
const HOOK_TTL_MS = Number(process.env.AIOS_HOOK_TTL || 9000);

// hook overrides set by hooks.js: sessionId -> { status, question, ts }
const hookState = new Map();
export function setHookState(id, status, question = null) {
  hookState.set(id, { status, question, ts: Date.now() });
}
export function clearHookState(id) {
  hookState.delete(id);
}

// The agent is actively processing (do NOT mark waiting even if the screen is static).
// Kept specific so prose like "Working with untrusted contents…" does NOT match — the
// common active case is already caught by output changing (low idle) regardless.
const WORKING_RX = [
  /esc(ape)? to interrupt/i,
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷◐◓◑◒]/, // braille/circle spinners
  /\b(thinking|generating|working|running|searching|reading|editing|applying|planning|compacting|summarizing|loading)\b\s*…/i, // "Working…"
];
// NB: codex's live elapsed timer ("(12s · Esc to interrupt)") is intentionally NOT a WORKING_RX pattern.
// As a static regex, `/\(\s*\d+\s*s\b/` matched ANY parenthetical "(<n>s" the agent merely PRINTED — a
// session analysing this very detector had "(9s TTL) …" in its own transcript and stuck at `working` for
// minutes while idle (operator report, s_f54892ae6d, 2026-07-12). Per this block's own rule above, a real
// timer TICKS, so a genuinely-working pane changes every second → idleMs stays < IDLE_WAIT_MS and the
// step-4 default already returns `working`. A live timer is thus caught by "output changing (low idle)"; a
// stale "(<n>s" on a long-idle pane is prose, not work, and must fall through to waiting. (esc-to-interrupt
// and the spinner glyph stay: they appear ONLY while an agent is live, even on a stabilized-static pane.)

// Background work is LIVE: the agent's footer reports one or more background terminals still running
// ("· 2 background terminals running · /ps to view"). This is ongoing work even when the FOREGROUND
// composer is idle, so the session must read as `working`, not settle to `waiting` and wrongly enter
// the needs-you queue (operator report). Deliberately NARROW: it must NOT match the always-present
// "ctrl+b to run in background" hint, nor the Bash tool-result line "Command running in background
// with ID …" (there "running" precedes "background").
//
// The hold is BOUNDED by BG_HOLD_MS of total pane stillness. The original "the footer clears when
// the bg process exits, so this is self-limiting" assumption is FALSE: an agent that finishes and
// deliberately leaves dev servers running ("No active task remains; awaiting the operator" + "5
// background terminals running") keeps the footer up forever, and the unbounded rule pinned that
// session `working` for ~20h — never surfacing in the needs-you queue, never getting supervisor
// stop-reviews (incident s_8ea0dbf260, 2026-07-12). After BG_HOLD_MS with no pane change the idle
// fall-through applies; the →waiting summarizer (which hides `working`-category false positives)
// is the second-layer filter for a genuinely-busy quiet session, so long silent bg work still does
// not spam the operator.
const BACKGROUND_RX = /\b\d+\s+background\s+(?:terminal|process|task|shell|bash|command)s?\s+running\b|\/ps\s+to\s+view\b/i;
const BG_HOLD_MS = Number(process.env.AIOS_BG_HOLD_MS || 10 * 60_000);

// The agent is explicitly blocked on a decision (approval / confirmation / menu).
const PROMPT_RX = [
  /do you want to (proceed|continue|allow)/i,
  /do you trust/i,
  /press enter to continue/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\by\/n\b/i,
  /❯?\s*1\.\s*(yes|allow|approve|proceed)/i,
  /\ballow\b[^?\n]{0,40}\?/i,
  /\bapprove\b/i,
  /waiting for (your )?(input|response|confirmation|approval)/i,
  /\bconfirm\b[^?\n]{0,30}\?/i,
];

// The session can't reach the model because its auth/token expired (claude OAuth, codex login,
// etc.). A relaunch (continuing the conversation) reloads the refreshed credentials and fixes it.
const AUTH_RX = /please run [`'"]*\/?(login|codex login)|please sign in|launch the cli without arguments to sign in|you are (currently )?not signed in|not logged into antigravity|invalid authentication credentials|api error:\s*401|authentication_error|oauth token (has )?expired|your (access|auth) token (has )?expired|session (has )?expired,?\s*please (re-?)?login/i;
// A login just completed in this pane -> signal Supercalm to refresh the provider's other stuck sessions.
const LOGIN_OK_RX = /login success|logged in success|successfully (logged in|authenticated)|authentication success|you('re| are) now logged in/i;
// A healthy agent-output line (claude's ⏺ response bullet / ⎿ tool-result). If one of these is more
// recent than any auth error in the tail, the model is currently reachable — the 401s above it are
// replayed `--continue` history, NOT a live failure. (AUTH_RX is tested first each iteration, so a
// "⏺ …API Error: 401" line never counts as healthy.)
const HEALTHY_RX = /^[⏺⎿]/;

// Tool chrome lines to ignore when extracting the question shown to the user.
const CHROME_RX =
  /^(>_ |model:|directory:|tip:|learn more:|to continue this session|token usage|gpt-[\d.]|claude-|antigravity|\? for shortcuts|\/\w+ to|esc |⏎|ctrl\b|press )/i;
// codex/claude rotating composer placeholders (template markers) — noise, not real questions.
const PLACEHOLDER_RX = /\{[a-z_]+\}|@filename|@dir\b/i;
const BORDERS = /[│╭╮╰╯─━┃┏┓┗┛▌▐•·]/g;

function lines(text) {
  return text
    .split('\n')
    .map((l) => l.replace(BORDERS, ' ').replace(/^\s*[›>⏎]+\s*/, '').replace(/\s+$/, '').trim())
    .filter(Boolean);
}
function meaningfulTail(text, n) {
  return lines(text)
    .filter((l) => l.length > 1 && !CHROME_RX.test(l) && !PLACEHOLDER_RX.test(l))
    .slice(-n);
}

const TRUST_PROMPT_RX = /do you trust|trust (?:this folder|the (?:files|contents|folder))|one you trust/i;

// Claude changed its first-run trust screen so the highlighted default is now "No, exit". Blindly
// pressing Enter (the old behaviour) exits the CLI with code 0, which looks like a clean process exit
// even though the project task never started. Parse the visible choices and their ACTUAL highlight so
// autonomous sessions select the affirmative choice, while Story can render the same prompt/options.
// Fail closed when the menu shape is unknown: the normal prompt detector then asks the operator.
export function terminalTrustPrompt(text) {
  const screen = stripAnsi(String(text || '')).replace(/\r/g, '');
  const raw = screen.split('\n');
  if (!TRUST_PROMPT_RX.test(screen.replace(/\s+/g, ' '))) return null;
  let promptAt = -1;
  for (let i = raw.length - 1; i >= 0; i--) {
    // Prefer the actual interrogative. Choice labels also contain "trust this folder" and must not
    // become the block start (doing so loses the highlighted option immediately above them).
    const possiblePrompt = raw.slice(i, i + 5).join(' ');
    if (TRUST_PROMPT_RX.test(possiblePrompt) && (/\?/.test(possiblePrompt) || /quick safety check/i.test(raw[i]))) { promptAt = i; break; }
  }
  if (promptAt < 0) {
    for (let i = raw.length - 1; i >= 0; i--) {
      if (TRUST_PROMPT_RX.test(raw[i]) && !/^\s*(?:[❯›>]\s*)?(?:\d+[.)]\s*)?(?:yes|no)\b/i.test(raw[i])) { promptAt = i; break; }
    }
  }
  if (promptAt < 0) return null;

  const clean = (line) => line.replace(BORDERS, ' ').replace(/\s+$/, '').trim();
  const end = Math.min(raw.length, promptAt + 24);
  const options = [];
  let footerAt = -1;
  for (let i = promptAt; i < end; i++) {
    if (/Enter to (?:confirm|select)|press enter to continue/i.test(raw[i])) { footerAt = i; break; }
    const m = clean(raw[i]).match(/^([❯›>])?\s*(?:\d+[.)]\s*)?((?:Yes\b.*\btrust\b.*)|(?:No\b.*\bexit\b.*))$/i);
    if (m) options.push({ line: i, label: m[2].replace(/\s+/g, ' ').trim(), selected: !!m[1] });
  }
  // The footer must be the final visible UI. A report can quote this entire menu above its live
  // composer; matching that quote would type navigation keys into an unrelated session (the same
  // failure class as the historical quoted feedback-survey incident).
  if (!options.length || footerAt < 0 || raw.slice(footerAt + 1).map(clean).some(Boolean)) return null;
  const selected = options.findIndex((option) => option.selected);
  const affirmative = options.findIndex((option) => /^yes\b/i.test(option.label) && /\btrust\b/i.test(option.label));

  const firstOptionLine = Math.min(...options.map((option) => option.line));
  const question = raw.slice(promptAt, firstOptionLine).map(clean).filter(Boolean).join('\n').trim();
  return {
    question: question || 'Do you trust this project folder?',
    options: options.map((option, index) => {
      const distance = selected < 0 ? null : index - selected;
      const keys = distance == null ? null : [
        ...Array.from({ length: Math.abs(distance) }, () => distance > 0 ? 'down' : 'up'),
        'enter',
      ];
      return { label: option.label, selected: option.selected, keys };
    }),
    affirmative,
    footer: footerAt >= 0 ? clean(raw[footerAt]) : '',
  };
}

export function trustConfirmKeys(text) {
  const prompt = terminalTrustPrompt(text);
  if (!prompt || prompt.affirmative < 0) return null;
  return prompt.options[prompt.affirmative]?.keys || null;
}

// Structured projection for terminal-native questions that never appear as AskUserQuestion calls in
// the model transcript. Story uses this to mirror the prompt and offer controls that operate the same
// live selector. The parser stays deliberately narrow: an uncertain screen falls back to a text reply,
// never speculative keys.
export function terminalQuestionPrompt(text) {
  const trust = terminalTrustPrompt(text);
  if (trust) return trust;

  const raw = stripAnsi(String(text || '')).replace(/\r/g, '').split('\n').slice(-32);
  const clean = (line) => line.replace(BORDERS, ' ').replace(/\s+$/, '').trim();

  // Conventional shell confirmation.
  for (let i = raw.length - 1; i >= 0; i--) {
    if (!/(?:\(y\s*\/\s*n\)|\[y\s*\/\s*n\]|\by\s*\/\s*n\b)/i.test(raw[i])) continue;
    if (raw.slice(i + 1).map(clean).some(Boolean)) continue;
    return {
      question: clean(raw[i]),
      options: [
        { label: 'Yes', selected: false, keys: ['y', 'enter'] },
        { label: 'No', selected: false, keys: ['n', 'enter'] },
      ],
    };
  }

  // Arrow-key numbered selector. Require both a footer and at least two numbered choices so prose or
  // a report quoting "1. ..." cannot become an actionable UI.
  const footerAt = raw.findLastIndex((line) => /Enter to (?:confirm|select)/i.test(line));
  if (footerAt >= 0 && !raw.slice(footerAt + 1).map(clean).some(Boolean)) {
    const candidates = [];
    for (let i = Math.max(0, footerAt - 16); i < footerAt; i++) {
      const m = clean(raw[i]).match(/^([❯›>])?\s*(\d+)[.)]\s+(.+)$/);
      if (m) candidates.push({ line: i, number: m[2], label: m[3].trim(), selected: !!m[1] });
    }
    if (candidates.length >= 2 && candidates.some((choice) => choice.selected)) {
      const selected = candidates.findIndex((choice) => choice.selected);
      const questionLines = raw.slice(Math.max(0, candidates[0].line - 6), candidates[0].line).map(clean).filter(Boolean);
      const lastQuestion = questionLines.findLastIndex((line) => /\?|:$/.test(line));
      const question = questionLines.slice(lastQuestion >= 0 ? lastQuestion : -1).join('\n').trim();
      return {
        question: question || 'Choose an option to continue.',
        options: candidates.map((choice, index) => {
          const distance = index - selected;
          return {
            label: choice.label,
            key: choice.number,
            selected: choice.selected,
            keys: [
              ...Array.from({ length: Math.abs(distance) }, () => distance > 0 ? 'down' : 'up'),
              'enter',
            ],
          };
        }),
      };
    }
  }

  // A terminal pause with one unambiguous action.
  for (let i = raw.length - 1; i >= 0; i--) {
    if (!/press enter to continue/i.test(raw[i])) continue;
    if (raw.slice(i + 1).map(clean).some(Boolean)) continue;
    return { question: clean(raw[i]), options: [{ label: 'Continue', selected: true, keys: ['enter'] }] };
  }
  return null;
}

function questionFrom(text) {
  const terminal = terminalQuestionPrompt(text);
  if (terminal) return [terminal.question, ...terminal.options.map((option) => option.label)].join('\n').slice(0, 2000);
  const tail = meaningfulTail(text, 5);
  const q = tail.join('\n').slice(0, 500).trim();
  return q || 'Waiting for your input';
}

// claude's session-feedback survey ("● How is Claude doing this session? … 0: Dismiss") — used ONLY by
// sendText()'s pre-dismiss, where a false match self-heals (the '0' is C-u'd away before the real text
// is typed). It must NEVER be an ambient CONFIRM_RULES gate: gates key the pane on mere screen text, so
// a session that merely DISPLAYS the survey wording — a report quoting it, a captured screen pasted into
// a transcript — gets keys typed into it. The session that shipped that gate received 258 stray '0's
// from its own quoted text (2026-07-13). Ambient auto-keying is reserved for prompts whose wording
// cannot plausibly appear as displayed content (trust/bypass screens).
export const CLAUDE_SURVEY_RX = /How is Claude doing this session\?[\s\S]{0,200}0:\s*Dismiss/i;

// Multi-question AskUserQuestion: after the LAST answer the TUI parks on a final "✔ Submit" step —
// nothing is delivered until it's confirmed. True only on the exact all-answered shape: the tab bar
// shows answered marks (☒/✔), NO pending ☐ tab, a Submit tab, and the selection footer is still up.
// sendText() confirms it with one Enter after answering via a menu (operator report 2026-07-17,
// s_07814eddc4: answers picked through AIOS sat "waiting on the submit confirm step" while the
// story claimed the session resumed). Codex menus have no tab bar → never matches (no-op).
export function askSubmitStepPending(screen) {
  const tail = stripAnsi(String(screen || '')).split('\n').slice(-16).join('\n');
  return /Enter to select/.test(tail) && /Submit/.test(tail) && /[☒✔]/.test(tail) && !/☐/.test(tail);
}

// Known one-time gates that an autonomous (auto/full) session may auto-accept.
// Keys are tmux key names; the bypass warning defaults to "No" so it needs Down first.
const CONFIRM_RULES = [
  // claude ExitPlanMode: "Claude has written up a plan and is ready to execute. Would you like to proceed?
  // ❯1. Yes, and bypass permissions  2. Yes, manually approve edits  3. Tell Claude what to change". Claude
  // now ALWAYS shows this after planning, even when the session launched with --dangerously-skip-permissions.
  // For an autonomous session the operator already granted permission at launch, so accept option 1 (the
  // highlighted default → Enter) and keep moving — option 2 would stall the agent on every edit.
  { rx: /written up a plan and is ready to execute/i, keys: ['enter'] },
  { rx: /bypass permissions mode/i, keys: ['down', 'enter'] }, // claude: select "2. Yes, I accept"
  // claude legacy API-key proxy path: "Detected a custom API key … Do you want to use this
  // API key? 1. Yes  ❯2. No". Pick "1. Yes" (Up + Enter).
  { rx: /detected a custom api key|do you want to use this api key/i, keys: ['up', 'enter'] },
];
function autoConfirmKeys(text) {
  const trust = trustConfirmKeys(text);
  if (trust) return trust;
  for (const r of CONFIRM_RULES) if (r.rx.test(text)) return r.keys;
  return null;
}

export function classify({ session, snap, idleMs, authGraceUntil }) {
  const hs = hookState.get(session.id);
  if (hs && Date.now() - hs.ts < HOOK_TTL_MS) return { status: hs.status, question: hs.question };

  const text = stripAnsi(snap || '');
  const tailLines = meaningfulTail(text, 16);
  const tailStr = tailLines.join('\n');
  const autonomous = session.autonomy === 'auto' || session.autonomy === 'full';

  // 1) known one-time gates (trust / bypass warning) — checked first, before the fuzzy
  //    "working" words, since these screens contain prose like "Working with untrusted…".
  const gate = autoConfirmKeys(text);
  if (gate) return autonomous ? { status: 'working', question: null, confirm: gate } : { status: 'waiting', question: questionFrom(text) };

  // 2) auth state — scan bottom-up for the MOST RECENT auth signal so a stale "Login successful"
  //    higher in the scrollback can't mask a fresh 401 below it (and vice-versa). Newest line wins.
  //    authNeeded -> clear waiting state Supercalm auto-recovers (relaunch --continue once creds are
  //    refreshed via a detected login or the Re-auth button); loginOk -> trigger that recovery.
  //    Two guards stop a RECOVERED session from re-flagging on replayed `--continue` history:
  //    (a) during the post-relaunch grace window skip the scan entirely (the pane is still
  //    reprinting old 401s before the first new exchange); (b) once a healthy ⏺/⎿ line appears
  //    below the newest error, the model is reachable now -> stop (the errors are history).
  const inAuthGrace = authGraceUntil && Date.now() < authGraceUntil;
  if (!inAuthGrace) {
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const ln = tailLines[i];
      if (AUTH_RX.test(ln)) return { status: 'waiting', question: 'Re-login required (auth/token expired)', authNeeded: true };
      if (LOGIN_OK_RX.test(ln)) return { status: 'working', question: null, loginOk: true };
      if (HEALTHY_RX.test(ln)) break; // recent successful model output -> older 401s are replayed history
    }
  }

  // 2) explicit approval / menu prompts -> waiting
  if (PROMPT_RX.some((rx) => rx.test(tailStr))) return { status: 'waiting', question: questionFrom(text) };

  // 3) active-processing indicators -> working
  if (WORKING_RX.some((rx) => rx.test(tailStr))) return { status: 'working', question: null };

  // 3b) background work still running -> working (checked AFTER PROMPT_RX so a genuine approval
  //     prompt shown alongside a bg terminal still surfaces as waiting, but BEFORE the idle fall-through
  //     so a quiet composer with live background terminals is not miscounted as needs-you). Bounded:
  //     past BG_HOLD_MS of stillness the footer is servers-left-running, not work — fall through.
  if (BACKGROUND_RX.test(tailStr) && !(idleMs > BG_HOLD_MS)) return { status: 'working', question: null };

  // 4) quiet for a while -> waiting
  if (idleMs > IDLE_WAIT_MS) return { status: 'waiting', question: questionFrom(text) };
  return { status: 'working', question: null };
}
