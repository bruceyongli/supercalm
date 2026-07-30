// One semantic brief for every Needs-you surface.
//
// The waiting projection is imperfect: when a model summary fails, `summary`, `question`, and
// `last_key.text` can all contain the agent TUI's task list, composer, permission mode, and token
// counter. Those strings are useful for debugging a terminal, but they are never an operator action.
// This module turns the available fields into the three things a person needs for a quick scan:
//   1. what they asked for;
//   2. what happened;
//   3. what they need to do now.

const ANSI_RX = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/g;
const TERMINAL_CHROME_RX = /(?:⏵⏵|▸▸|▶▶|bypass permissions|shift\+tab(?:\s+to\s+cycle)?|new task\?|\/clear(?:\s+to\s+save)?|esc to interrupt|context (?:used|left)|\d+(?:\.\d+)?k?\s+tokens?\b|ctrl\+[a-z]\s+to\b|auto-accept|remote-mac-gui-control)/i;
const PROCESS_PREFIX_RX = /^\s*[✻✽✶✢✳·∗◐◓◑◒]?\s*(?:brewed|sautéed|cogitated|thought|thinking|worked|crunched|churned)\s+for\s+\d+[hms](?:\s+\d+[hms])?\s*/i;

function clipped(value, max) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  const head = text.slice(0, Math.max(1, max - 1));
  const word = head.replace(/\s+\S*$/, '').trim();
  return `${word || head.trim()}…`;
}

export function hasAttentionChrome(value) {
  return TERMINAL_CHROME_RX.test(String(value || '')) || PROCESS_PREFIX_RX.test(String(value || ''));
}

function completedTaskSummary(text) {
  if (!/[✔✓]/.test(text)) return '';
  const more = Number(text.match(/…?\s*\+(\d+)\s+completed\b/i)?.[1] || 0);
  const tasks = [...text.matchAll(/[✔✓]\s*([^✔✓]+?)(?=[✔✓]|…?\s*\+\d+\s+completed\b|$)/g)]
    .map((match) => match[1]
      .replace(/\s*….*$/, '')
      .replace(/\s+(?:[\w]+-){2,}[\w-]+\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean)
    .slice(0, 2);
  if (!tasks.length) return '';
  const total = tasks.length + more;
  const examples = tasks.length === 1 ? tasks[0] : `${tasks[0]} and ${tasks[1]}`;
  return more
    ? `Completed ${total} items, including ${examples}.`
    : `Completed ${examples}.`;
}

export function cleanAttentionText(value, max = 300) {
  let text = String(value || '')
    .replace(ANSI_RX, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*`>~]+/g, ' ')
    .replace(/\u00a0/g, ' ');

  // Some Claude screens flatten to “timer project-name ❯ useful command ▸▸ footer”. In that exact
  // shape the text after the prompt glyph is the only human-readable fragment.
  if (PROCESS_PREFIX_RX.test(text) && text.includes('❯')) text = text.slice(text.lastIndexOf('❯') + 1);
  text = text.replace(PROCESS_PREFIX_RX, '');

  const chromeAt = [
    text.search(/(?:⏵⏵|▸▸|▶▶)/),
    text.search(/\bbypass permissions\b/i),
    text.search(/\bnew task\?/i),
    text.search(/\/clear(?:\s+to\s+save)?/i),
    text.search(/\besc to interrupt\b/i),
    text.search(/\b\d+(?:\.\d+)?k?\s+tokens?\b/i),
  ].filter((index) => index >= 0);
  if (chromeAt.length) text = text.slice(0, Math.min(...chromeAt));

  text = text
    .replace(/\bshift\+tab(?:\s+to\s+cycle)?\b/gi, ' ')
    .replace(/\bremote-mac-gui-control\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tasks = completedTaskSummary(text);
  return clipped(tasks || text, max);
}

function comparable(value) {
  return cleanAttentionText(value, 1200)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function sameAttentionMessage(left, right) {
  const a = comparable(left);
  const b = comparable(right);
  if (!a || !b) return false;
  if (a === b) return true;
  // Reports are independently truncated by the home projection. A substantial prefix/substring is
  // the same message, not a second operator request.
  return Math.min(a.length, b.length) >= 64 && (a.includes(b) || b.includes(a));
}

function defaultHappened(category) {
  if (category === 'decision') return 'The agent paused at a decision point.';
  if (category === 'action') return 'The agent is blocked until it gets your input.';
  return 'The agent finished its latest turn and is waiting for your review.';
}

function isOperatorAsk(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 220) return false;
  return /\?\s*$/.test(text)
    || /^(?:please\s+)?(?:choose|select|decide|approve|confirm|provide|reply|tell|enter|pick|which|when|where|why|how|should|would|do you|can you)\b/i.test(text);
}

function actionFromReport(report, category) {
  const ready = report.match(/\bready to ([^.;]+?)\s+(?:but|and)\s+needs?\s+(?:(?:the\s+)?operator(?:'s)?|your)?\s*approval\b/i);
  if (ready?.[1]) return { text: `Approve this next step: ${ready[1].trim()}. Or reply with changes.`, source: 'report' };
  const approval = report.match(/\bneeds?\s+(?:(?:the\s+)?operator(?:'s)?|your)\s+approval\s+to\s+([^.;]+)/i);
  if (approval?.[1]) return { text: `Approve this next step: ${approval[1].trim()}. Or reply with changes.`, source: 'report' };
  if (category === 'decision') return { text: 'Reply with the decision the agent needs to continue.', source: 'default' };
  if (category === 'action') return { text: 'Reply with the missing information or instruction so work can continue.', source: 'default' };
  return { text: 'Review the result. Reply with changes, or dismiss it if you’re satisfied.', source: 'default' };
}

export function attentionCopy({
  request,
  title,
  question,
  summary,
  fallback,
  category,
  optionCount = 0,
} = {}) {
  const requested = cleanAttentionText(request || title, 220);
  const rawAsk = String(question || '');
  const rawUpdate = String(summary || '');
  const rawReport = String(fallback || '');
  const ask = cleanAttentionText(rawAsk, 300);
  const update = cleanAttentionText(rawUpdate, 300);
  const report = cleanAttentionText(rawReport, 300);
  const askIsChrome = hasAttentionChrome(rawAsk);
  const updateIsChrome = hasAttentionChrome(rawUpdate);
  const explicitlyActionable = category === 'action' || category === 'decision';

  let happened = '';
  let action = '';
  let actionSource = 'default';

  if (optionCount > 0) {
    happened = update && !sameAttentionMessage(update, ask) && !updateIsChrome
      ? update
      : defaultHappened('decision');
    action = optionCount > 1
      ? 'Answer each question below. Your choices send after the last answer.'
      : 'Choose an option below to continue the session.';
    actionSource = 'options';
  } else if (ask && !askIsChrome && explicitlyActionable) {
    happened = update && !sameAttentionMessage(ask, update) ? update : defaultHappened(category);
    action = ask;
    actionSource = 'question';
  } else if (ask && update && !askIsChrome && !sameAttentionMessage(ask, update) && isOperatorAsk(ask)) {
    happened = update;
    action = ask;
    actionSource = 'question';
  } else {
    const sameCleanReport = ask && update && sameAttentionMessage(ask, update);
    const candidate = sameCleanReport
      ? (ask.length >= update.length ? ask : update)
      : update || ask || report;
    happened = candidate || defaultHappened(category);
    ({ text: action, source: actionSource } = actionFromReport(candidate, category));
  }

  // A failed summarizer can leave only terminal chrome. Keep a useful state sentence instead of
  // promoting a cleaned fragment such as a task-list footer into the action box.
  if ((!happened || (updateIsChrome && !/[✔✓]/.test(rawUpdate))) && !report) happened = defaultHappened(category);
  if (!action || hasAttentionChrome(action)) ({ text: action, source: actionSource } = actionFromReport(happened, category));
  if (sameAttentionMessage(happened, action)) {
    happened = defaultHappened(category);
    ({ text: action, source: actionSource } = actionFromReport(cleanAttentionText(update || ask || report, 300), category));
  }

  const mode = happened && action ? 'brief' : action ? 'action' : 'update';
  return {
    request: requested,
    happened: cleanAttentionText(happened, 260),
    action: cleanAttentionText(action, 300),
    // Compatibility names for existing consumers while every surface moves to the semantic labels.
    latest: cleanAttentionText(happened, 260),
    actionSource,
    mode,
  };
}
