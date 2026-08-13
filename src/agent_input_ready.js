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

function transientInputScreen(screen) {
  const tail = cleanAgentScreen(screen).split('\n').slice(-24).join('\n');
  return /Starting MCP servers|Compacting (?:conversation|context)|Compacting…|Loading (?:conversation|session)|Initializing agent/i.test(tail);
}

function activeAgentScreen(screen) {
  const tail = cleanAgentScreen(screen).split('\n').slice(-24).join('\n');
  return /(?:esc|ctrl-c) to interrupt|bypass permissions|accept edits|(?:gpt-[\w.-]+|% context left|\bxhigh\b)/i.test(tail);
}

export function pendingComposerDraft(screen) {
  const tail = cleanAgentScreen(screen).split('\n').map((line) => line.trimEnd()).filter((line) => line.trim()).slice(-6);
  for (let i = tail.length - 1; i >= 0; i--) {
    const match = tail[i].match(/^\s*([›❯])\s+(.+?)\s*$/);
    if (!match) continue;
    const after = tail.slice(i + 1);
    if (after.some((line) => !/(?:gpt-[\w.-]+|% context left|\bxhigh\b|bypass permissions|accept edits|plan mode|shift\+tab)/i.test(line))) continue;
    const text = match[2].trim();
    if (codexComposerPlaceholder(text) || /^(?:Ask Claude|Try ["“])/.test(text)) continue;
    return { marker: match[1], text };
  }
  return null;
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
  // A live composer at the bottom outranks matching words still visible in scrollback above it.
  if (agentInputReady(screen)) return { ready: true, target: 'composer' };
  if (claudeResumePrompt(screen)) return menuAnswer
    ? { ready: true, target: 'choice-menu' }
    : { ready: false, reason: 'resume-choice' };
  if (transientInputScreen(screen)) return { ready: false, reason: 'input-not-ready' };
  if (askMenuTypeDigit(screen)) return { ready: true, target: 'custom-answer' };
  if (menuAnswer && numberedChoicePrompt(screen)) return { ready: true, target: 'choice-menu' };
  // Both coding TUIs accept an operator steering/interruption while a turn is running. Preserve that
  // path, but only when the durable session state says it is working and a real agent footer is visible.
  if (allowActive && activeAgentScreen(screen)) return { ready: true, target: 'active-agent' };
  return { ready: false, reason: 'input-not-ready' };
}
