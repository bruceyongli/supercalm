import assert from 'node:assert/strict';
import { detectProviderIssue, providerIssueFromError, providerIssueInfo, providerRetryMatches } from '../src/provider_status.js';
import { parseSessionLog } from '../src/story.js';
import { sessionIndicator } from '../web/session-indicator.js';

const cases = [
  ['capacity', 'Selected model is at capacity. Please try a different model.', true],
  ['rate_limit', 'API Error: 429 {"error":{"type":"rate_limit_error","message":"Too many requests"}}', true],
  ['rate_limit', "You've hit your usage limit. Try again at 12:00.", true],
  ['overloaded', 'API Error: 529 overloaded_error', true],
  ['transient', 'API Error: 503 Service unavailable', true],
  ['transient', 'stream disconnected before completion: connection reset', true],
  ['transient', 'unexpected status 502 Bad Gateway: upstream disconnected', true],
  ['transient', 'error sending request for url (https://provider.example/v1/responses)', true],
  ['transient', 'stream errored before completion: connection closed', true],
  ['rate_limit', 'exceeded retry limit, last status: 429 Too Many Requests', true],
  ['authentication', 'API Error: 401 authentication_error', false],
  ['billing', 'API Error: 402 billing_error: insufficient credit balance', false],
  ['permission', 'API Error: 403 permission_error: access denied', false],
  ['context', 'API Error: 400 prompt is too long', false],
  ['model', 'API Error: model_not_found: selected model does not exist', false],
  ['model', 'The requested model example-v2 is not available.', false],
  ['request', 'API Error: 400 invalid_request_error: unsupported parameter', false],
  ['generic', 'API Error: unexpected provider response', false],
];
for (const [code, text, retryable] of cases) {
  const issue = { code, phase: 'blocked' };
  for (const tool of ['claude', 'codex', 'agy']) {
    assert.deepEqual(detectProviderIssue(`■ ${text}\n› Unsent draft\n? for shortcuts`, { tool }), issue, `${tool}: ${text}`);
    assert.equal(detectProviderIssue(`■ ${text}\n• Healthy work continued\n› `, { tool }), null);
    assert.equal(detectProviderIssue(`■ ${text}\nThe request succeeded.\n› `, { tool }), null);
    assert.equal(detectProviderIssue(`› Fix this:\n  ${text}\n? for shortcuts`, { tool }), null);
    assert.equal(detectProviderIssue(`\`\`\`\n■ ${text}\n\`\`\``, { tool }), null);
    for (const quote of [`> ${text}`, `"${text}"`, `const fixture = '${text}'`, `| Error | ${text} |`, `⏺ Bash(echo '${text}')`]) {
      assert.equal(detectProviderIssue(quote, { tool }), null, quote);
    }
  }
  assert.equal(providerIssueInfo(issue).retryable, retryable);
  assert.equal(sessionIndicator({ status: 'waiting', provider_issue: issue }).blocked, true);
  const session = { status: 'waiting', provider_issue: JSON.stringify(issue) };
  assert.equal(providerRetryMatches(session, { id: 42 }, { code, reportId: 42 }), retryable);
  assert.equal(providerRetryMatches(session, { id: 43 }, { code, reportId: 42 }), false);
  assert.equal(providerRetryMatches({ ...session, status: 'working' }, { id: 42 }, { code, reportId: 42 }), false);
  assert.equal(providerIssueInfo({ code, phase: 'retrying' }).retryable, false);
  const records = [
    { type: 'assistant', timestamp: '2026-10-23T12:00:01Z', isApiErrorMessage: true,
      message: { id: 'native_error', content: [{ type: 'text', text }], stop_reason: 'end_turn' } },
    { type: 'event_msg', timestamp: '2026-10-23T12:00:01Z', payload: { type: 'error', message: text } },
  ];
  for (const record of records) {
    const [event] = parseSessionLog(JSON.stringify(record));
    assert.equal(event.kind, 'fail'); assert.deepEqual(event.providerIssue, issue);
    assert.equal(event.body, text); assert.equal(event.title, providerIssueInfo(issue).title);
  }
}
assert.equal(detectProviderIssue('⎿ Error: npm test exited with code 1'), null, 'a tool failure is not a provider failure');
assert.equal(detectProviderIssue('API Error: no error after retry'), null);
assert.equal(detectProviderIssue('API Error: 503 Service unavailable\n  Working… (2s · esc to interrupt)'), null);
assert.deepEqual(detectProviderIssue('⎿ API Error: 529 overloaded_error · Retrying in 4 seconds… (attempt 2/10)'), { code: 'overloaded', phase: 'retrying' });
assert.deepEqual(detectProviderIssue('■ Selected model is at capacity. Please try a different model. · Retrying in 2 seconds…'), { code: 'capacity', phase: 'retrying' });
assert.equal(detectProviderIssue('■ API Error: 503\n  {"error":{"type":"api_error","message":"Service unavailable"}}').code, 'transient');
assert.equal(providerIssueFromError('authentication_failed').code, 'authentication', 'typed StopFailure needs no terminal prefix');
const error = { type: 'assistant', timestamp: '2026-10-23T12:00:01Z', isApiErrorMessage: true,
  message: { content: 'API Error: Bearer fixture-secret api_key=fixture-key access_token=fixture-token sk-1234567890123456' } };
assert.doesNotMatch(parseSessionLog(JSON.stringify(error))[0].body, /fixture-secret|fixture-key|fixture-token|sk-123/);
assert.equal(parseSessionLog(JSON.stringify({ type: 'event_msg', payload: { type: 'error', error: { type: 'rate_limit_error' } } }))[0].body,
  'rate_limit_error', 'structured native errors never render as [object Object]');
console.log('provider_story: all CLI/provider categories, false-positive guards, native errors, redaction and episode-scoped retry passed');
