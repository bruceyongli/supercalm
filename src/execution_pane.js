// Session targets are not necessarily pane targets in tmux display-message.
// Parse list-panes evidence only for one exact, live pane in the selected session.
export function parseExecutionPane(output, sessionName) {
  const lines = String(output || '').trimEnd().split('\n');
  const [session, paneId, rawPid, command, dead, ...extra] = lines[0].split('|');
  const pid = Number(rawPid);
  if (!sessionName || /[|\r\n\0]/.test(sessionName) || lines.length !== 1 || extra.length
      || session !== sessionName || !/^%\d+$/.test(paneId || '') || !/^[1-9]\d*$/.test(rawPid || '')
      || !Number.isSafeInteger(pid) || !command || /[\r\n\0]/.test(command) || dead !== '0') {
    throw Error('Source terminal pane identity is unavailable');
  }
  return { paneId, pid, command };
}
