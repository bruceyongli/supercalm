// Pure shared presentation contract. These are provider failures, never permission questions or
// evidence that the coding process died. Only a deliberate operator click may retry a request.
const ISSUES = {
  capacity: ['Model at capacity', 'Retry later or choose another model.', true],
  rate_limit: ['Provider usage limit', 'Wait for the limit to reset, or choose another model/provider.', true],
  overloaded: ['Provider overloaded', 'Retry later or choose another model.', true],
  transient: ['Provider connection failed', 'Check the connection, then retry the current task.', true],
  authentication: ['Provider login required', 'Sign in again before continuing.', false],
  billing: ['Provider credits required', 'Check the provider’s credits or billing before continuing.', false],
  permission: ['Model access denied', 'Check account access or choose an available model.', false],
  context: ['Conversation exceeds the model limit', 'Use the CLI’s context/compact controls in Terminal before continuing.', false],
  model: ['Model unavailable', 'Choose an available model in the composer settings.', false],
  request: ['Provider rejected the request', 'Review the error in Terminal and correct the request or settings before continuing.', false],
  generic: ['Provider request failed', 'Open Terminal for the error details before retrying.', false],
};

export function providerIssue(value) {
  try {
    const issue = typeof value === 'string' ? JSON.parse(value) : value;
    if (!issue || !Object.hasOwn(ISSUES, issue.code) || !['blocked', 'retrying'].includes(issue.phase)) return null;
    return { code: issue.code, phase: issue.phase };
  } catch { return null; }
}

export function providerIssueInfo(value) {
  const issue = providerIssue(value);
  if (!issue) return null;
  const [title, advice, retryable] = ISSUES[issue.code];
  const retrying = issue.phase === 'retrying';
  return { title, advice, retryable: retryable && !retrying,
    message: retrying ? `${title} — the CLI is retrying.` : `${title}. ${advice}` };
}

export const PROVIDER_CONTINUE_TEXT = 'Continue the current task from where you left off.';
