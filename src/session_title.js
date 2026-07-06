export const SESSION_TITLE_MAX = 90;

export function cleanSessionTitle(title, { max = SESSION_TITLE_MAX } = {}) {
  return String(title || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

function firstUsefulLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((s) => cleanSessionTitle(s, { max: 140 }))
    .find((s) => s && !/^(okay|ok|go ahead|thanks|thank you)$/i.test(s));
}

export function fallbackSessionTitle({ session = {}, messages = [], events = [] } = {}) {
  const incoming = [...messages].reverse().find((m) => m.direction === 'in' && firstUsefulLine(m.text));
  const event = [...events].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)).find((e) => {
    try {
      const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
      return firstUsefulLine(p?.task || p?.summary || p?.title || p?.text);
    } catch {
      return false;
    }
  });
  let fromEvent = '';
  if (event) {
    try {
      const p = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
      fromEvent = firstUsefulLine(p?.task || p?.summary || p?.title || p?.text);
    } catch {}
  }
  return cleanSessionTitle(firstUsefulLine(incoming?.text) || fromEvent || session.summary || session.title || 'Session');
}

export function titleContext({ session = {}, project = null, messages = [], events = [] } = {}) {
  const msgLines = messages
    .slice(-12)
    .map((m) => `${m.direction === 'in' ? 'operator' : 'agent'}: ${cleanSessionTitle(m.text, { max: 260 })}`)
    .filter((s) => !s.endsWith(':'));
  const eventLines = events
    .slice(0, 8)
    .map((e) => {
      try {
        const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
        return `${e.type}: ${cleanSessionTitle(p?.task || p?.summary || p?.title || p?.reason || '', { max: 220 })}`;
      } catch {
        return '';
      }
    })
    .filter((s) => s && !s.endsWith(':'));
  return [
    `project: ${project?.name || '(adhoc)'}`,
    `tool: ${session.tool || ''}`,
    `current title: ${session.title || ''}`,
    session.summary ? `current summary: ${session.summary}` : '',
    msgLines.length ? `recent messages:\n${msgLines.join('\n')}` : '',
    eventLines.length ? `recent events:\n${eventLines.join('\n')}` : '',
  ].filter(Boolean).join('\n\n').slice(0, 6000);
}
