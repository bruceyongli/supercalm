// Pure readiness check for a freshly launched/resumed agent TUI. Startup banners and MCP loading
// screens are not safe input targets: tmux accepts keystrokes there, but the agent never records the
// message. Only the live composer markers near the bottom of the visible pane count as ready.
export function cleanAgentScreen(screen) {
  return String(screen || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
}

export function pendingComposerDraft(screen) {
  const tail = cleanAgentScreen(screen).split('\n').map((line) => line.trimEnd()).filter((line) => line.trim()).slice(-6);
  for (let i = tail.length - 1; i >= 0; i--) {
    const match = tail[i].match(/^\s*([›❯])\s+(.+?)\s*$/);
    if (!match) continue;
    const after = tail.slice(i + 1);
    if (after.some((line) => !/(?:gpt-[\w.-]+|% context left|\bxhigh\b|bypass permissions|accept edits|plan mode|shift\+tab)/i.test(line))) continue;
    const text = match[2].trim();
    if (text === 'Implement {feature}' || /^(?:Ask Claude|Try ["“])/.test(text)) continue;
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
      ? body === 'Implement {feature}'
      : /^(?:Ask Claude|Try ["“])/.test(body);
    if (body && !placeholder) return false;
    const after = tail.slice(index + 1, index + 7).join('\n');
    return marker === '›'
      ? /(?:gpt-[\w.-]+|% context left|\bxhigh\b)/i.test(after)
      : /(?:bypass permissions|accept edits|plan mode|shift\+tab)/i.test(after);
  });
}
