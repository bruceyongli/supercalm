// Pure readiness check for a freshly launched/resumed agent TUI. Startup banners and MCP loading
// screens are not safe input targets: tmux accepts keystrokes there, but the agent never records the
// message. Only the live composer markers near the bottom of the visible pane count as ready.
export function cleanAgentScreen(screen) {
  return String(screen || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
}

export function askMenuTypeDigit(screen) {
  const clean = cleanAgentScreen(screen);
  if (!/Enter to select|to navigate/.test(clean)) return null;
  const match = clean.match(/(\d+)\.\s*Type something/i);
  return match ? match[1] : null;
}

export function claudeResumePrompt(screen) {
  const tail = cleanAgentScreen(screen).split('\n').slice(-24).join('\n');
  return /Resuming the full session will consume a substantial portion of your usage limits/i.test(tail)
    && /1\.\s*Resume from summary/i.test(tail)
    && /2\.\s*Resume full session as-is/i.test(tail)
    && /Enter to confirm/i.test(tail);
}

// Codex renders rotating grey suggestions in the otherwise-ready composer. tmux's plain capture loses
// the grey styling, so keep the small canonical set here. Treating one as a composer is safe even when
// the operator deliberately types the identical phrase: sendText clears and retypes that same text.
export function codexComposerPlaceholder(text) {
  return /^(?:Implement \{feature\}|Explain this codebase|Summarize recent commits|Run \/review on my current changes|Write tests for @filename)$/i
    .test(String(text || '').trim());
}

function numberedChoicePrompt(screen) {
  const tail = cleanAgentScreen(screen).split('\n').slice(-24).join('\n');
  return /(?:^|\n)\s*[❯›]?\s*1\.\s+\S/m.test(tail)
    && /(?:^|\n)\s*2\.\s+\S/m.test(tail)
    && /Enter to (?:confirm|select)/i.test(tail);
}

function transientInputReason(screen) {
  const tail = cleanAgentScreen(screen).split('\n').slice(-24).join('\n');
  if (/Starting MCP servers|Initializing agent/i.test(tail)) return 'agent-starting';
  if (/Compacting (?:conversation|context)|Compacting…/i.test(tail)) return 'agent-compacting';
  if (/Loading (?:conversation|session)/i.test(tail)) return 'agent-loading';
  return null;
}

function activeAgentScreen(screen) {
  const tail = cleanAgentScreen(screen).split('\n').slice(-24).join('\n');
  return /(?:esc|ctrl-c) to interrupt|bypass permissions|accept edits|(?:gpt-[\w.-]+|% context left|\bxhigh\b)/i.test(tail);
}

export function pendingComposerDraft(screen, { requireFooter = false } = {}) {
  const tail = cleanAgentScreen(screen).split('\n').map((line) => line.trimEnd()).slice(-24);
  const footerRx = /(?:gpt-[\w.-]+|% context left|\bxhigh\b|bypass permissions|accept edits|plan mode|shift\+tab)/i;
  const ruleRx = /^\s*[─━═╌╍┄┅┈┉⎯_-]{8,}\s*$/;
  for (let i = tail.length - 1; i >= 0; i--) {
    const match = tail[i].match(/^\s*([›❯])\s+(.+?)\s*$/);
    if (!match) continue;
    const after = tail.slice(i + 1, i + 10);
    const footerAt = after.findIndex((line) => footerRx.test(line));
    if (footerAt < 0 && requireFooter) continue; // delivery needs proof of the LIVE composer
    // Provenance inspection also consumes saved tails that end exactly on the composer line. It may use
    // that display as an UNSUBMITTED draft (never as delivery readiness), so no-footer is allowed only
    // when nothing except blank lines follows it.
    if (footerAt < 0 && after.some((line) => line.trim())) continue;
    const continuation = after.slice(0, footerAt < 0 ? 0 : footerAt)
      .map((line) => line.trim())
      .filter((line) => line && !ruleRx.test(line));
    // Only plain wrapped composer text may sit between the prompt and footer. A tool/result marker means
    // this was a transcript prompt near the bottom, not Claude's current input box.
    if (continuation.some((line) => /^[⏺✻✢⎿●○◉]/.test(line))) continue;
    const text = [match[2].trim(), ...continuation].join(' ').replace(/\s+/g, ' ').trim();
    if (codexComposerPlaceholder(text) || /^(?:Ask Claude|Try ["“])/.test(text)) continue;
    return { marker: match[1], text };
  }
  return null;
}

export function pendingDraftMatches(pending, requested) {
  const visible = String(pending || '').replace(/\s+/g, ' ').trim();
  const wanted = String(requested || '').replace(/\s+/g, ' ').trim();
  if (!visible || !wanted) return false;
  if (visible === wanted) return true;
  // Claude truncates a long composer line with a real ellipsis in capture-pane. The visible prefix is
  // still enough to recognize a retry of that same message, so submit it instead of clearing/retyping.
  return visible.endsWith('…') && wanted.startsWith(visible.slice(0, -1).trimEnd());
}

export function agentInputReady(screen) {
  const clean = cleanAgentScreen(screen);
  const tail = clean.split('\n').slice(-24);
  return tail.some((line, index) => {
    const match = line.match(/^\s*([›❯])\s*(.*?)\s*$/);
    if (!match) return false;
    const [, marker, body] = match;
    // A prompt glyph in transcript text is not sufficient. Require either an empty composer or a
    // known idle placeholder, adjacent to the tool's status/footer region near the pane bottom.
    const placeholder = marker === '›'
      ? codexComposerPlaceholder(body)
      : /^(?:Ask Claude|Try ["“])/.test(body);
    if (body && !placeholder) return false;
    const after = tail.slice(index + 1, index + 7).join('\n');
    return marker === '›'
      ? /(?:gpt-[\w.-]+|% context left|\bxhigh\b)/i.test(after)
      : /(?:bypass permissions|accept edits|plan mode|shift\+tab)/i.test(after);
  });
}

// Programmatic text must land on a real composer or an explicitly answered choice form. tmux accepting
// bytes is not delivery proof: startup/compaction screens and Claude's post-resume modal consume keys
// without creating a user turn. The operator-input path uses this gate before it reports HTTP success.
export function operatorInputDisposition(screen, { menuAnswer = false, allowActive = false } = {}) {
  // A live input target at the bottom (empty composer, choice form, or pending draft) outranks
  // transient words such as "Loading session" that may still be visible in scrollback above it.
  if (agentInputReady(screen)) return { ready: true, target: 'composer' };
  if (claudeResumePrompt(screen)) return menuAnswer
    ? { ready: true, target: 'choice-menu' }
    : { ready: false, reason: 'resume-choice' };
  if (askMenuTypeDigit(screen)) return { ready: true, target: 'custom-answer' };
  if (menuAnswer && numberedChoicePrompt(screen)) return { ready: true, target: 'choice-menu' };
  const pending = pendingComposerDraft(screen, { requireFooter: true });
  if (pending) return { ready: false, reason: 'pending-draft', draft: pending.text };
  const transient = transientInputReason(screen);
  if (transient) return { ready: false, reason: transient };
  // Both coding TUIs accept an operator steering/interruption while a turn is running. Preserve that
  // path, but only when the durable session state says it is working and a real agent footer is visible.
  if (allowActive && activeAgentScreen(screen)) return { ready: true, target: 'active-agent' };
  return { ready: false, reason: 'input-unavailable' };
}

// Resolve an explicit operator send against the native TUI composer. A pending Terminal draft is not a
// recovery screen: retrying the same text should press Enter on it, while a genuinely different Story
// message needs an explicit replace flag so the caller can preserve the displaced draft first.
export function operatorInputPlan(screen, requested, opts = {}) {
  const disposition = operatorInputDisposition(screen, opts);
  if (disposition.ready || disposition.reason !== 'pending-draft') return disposition;
  if (pendingDraftMatches(disposition.draft, requested)) {
    return { ready: true, target: 'existing-draft', draft: disposition.draft };
  }
  if (opts.replacePendingDraft) {
    return { ready: true, target: 'replace-draft', draft: disposition.draft };
  }
  return disposition;
}

export function operatorInputBlockMessage(reason) {
  switch (reason) {
    case 'resume-choice':
      return 'Session is on its recovery screen. Your draft was kept; choose a recovery option or send again when the composer is ready.';
    case 'pending-draft':
      return 'Terminal has a different unfinished draft. Your Story message was kept.';
    case 'agent-starting':
      return 'The agent is still starting. Your draft was kept; send again when its input box appears.';
    case 'agent-compacting':
      return 'The agent is compacting its context. Your draft was kept; send again when it finishes.';
    case 'agent-loading':
      return 'The agent is loading its session. Your draft was kept; send again when its input box appears.';
    default:
      return "The agent's input box could not be identified safely. Your draft was kept; open Terminal to inspect its current screen.";
  }
}
