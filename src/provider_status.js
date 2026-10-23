// A live provider failure is neither an operator question nor a dead CLI. Keep this separate from
// process lifecycle so Stop/Resume, native conversation identity and queued input are unchanged.
import { stripAnsi } from './util.js';
import { claudeTerminalFrame } from './claude_lifecycle.js';
import { classifyErrorType, CONTEXT_WEDGE_RX, ERR_CLEARED_RX } from './agents/supervisor/session_errors.js';
import { providerIssue, providerIssueInfo } from '../web/provider-issue.js';
export { providerIssue, providerIssueInfo } from '../web/provider-issue.js';

// The caller must supply native error provenance (e.g. StopFailure/isApiErrorMessage), NOT agent
// prose or tool output. Unknown typed errors remain visible rather than silently disappearing.
export function providerIssueFromError(value, { retrying = false } = {}) {
  const text = typeof value === 'string' ? value : String(value?.message || value?.type || '');
  let code;
  if (/selected model is at capacity/i.test(text)) code = 'capacity';
  else if (/\b401\b|authentication[_ ](?:failed|error)|cloud_credential_error|unauthori[sz]ed|(?:token|credentials?).*(?:expired|invalid)|please (?:run|use).*\/login|not logged in/i.test(text)) code = 'authentication';
  else if (CONTEXT_WEDGE_RX.test(text) || /context_length_exceeded|context_window_exceeded/i.test(text)) code = 'context';
  else if (/model_not_found|model_not_available|\bmodel\b.{0,100}\b(?:not found|not available|does not exist|not supported|unavailable)\b/i.test(text)) code = 'model';
  else {
    code = classifyErrorType(text);
    if (code === 'generic' && /hit your (?:usage )?limit|too many requests|resource_exhausted/i.test(text)) code = 'rate_limit';
    if (code === 'generic' && /\b(?:500|502|503|504)\b|connection (?:failed|refused)|econnrefused|fetch failed|network error|error (?:sending request|decoding response)|stream errored/i.test(text)) code = 'transient';
    if (code === 'generic' && /\b(?:400|422)\b|invalid_request_error|bad request/i.test(text)) code = 'request';
  }
  return { code, phase: retrying ? 'retrying' : 'blocked' };
}

export function providerIssueMessage(issue) {
  return providerIssueInfo(issue)?.message || '';
}

const CAPACITY = /^(?:[■⏺⎿✘✖⚠×]\s*)?(?:(?:API\s+)?Error:\s*)?Selected model is at capacity\.\s*Please try a different model\.?$/i;
const RETRY = /^(?:[■⏺⎿✘✖⚠×⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*)?(?:Retrying(?:\s+(?:automatically|request|in\s+\d+(?:\.\d+)?\s*(?:ms|s|seconds?|minutes?)))?|Reconnecting)(?:\s*\(?\d+\s*\/\s*\d+\)?|[. …:–—-].*)?$/i;
const CHROME = /^(?:[─━═_-]{3,}|[?？] for shortcuts.*|(?:\d+%|[\d,.]+[kKmM]?) context (?:left|used).*|(?:gpt-|claude-)[\w. /-]+|(?:shift\+tab|ctrl\+|⌃|⏵⏵|⏸).*|(?:Ask Codex to do anything|Find and fix a bug in @filename|Run \/review on my current changes)|[✻✢✽✶✳✼*]\s*\w+ for \d.*)$/i;
// An error keyword deep in a report, SQL row, test fixture or Bash result is not a provider event.
// Require an API-specific prefix/reason phrase, or one of the CLI's explicit native failure lines.
const API_ERROR = /^(?:API Error\s*:|(?:Error:\s*)?(?:[a-z_]+_error\b|(?:400|401|402|403|404|422|429|5\d\d)\s+(?:bad request|unauthorized|payment required|forbidden|not found|unprocessable|too many requests|internal server error|bad gateway|service unavailable|gateway time.?out|overloaded))|stream (?:error|disconnected before completion)\b|connection (?:error|reset|refused)\b|(?:you(?:'|’)ve|you have) hit your (?:usage )?limit\b|rate limit (?:reached|exceeded)\b|your credit balance is too low\b|prompt is too long\b|maximum context length exceeded\b|model\b.{0,100}\b(?:not found|not available|does not exist|not supported)\b)/i;
const TRANSPORT_ERROR = /^(?:unexpected status(?: code)?\s*:?\s*[45]\d\d\b|exceeded retry limit,? last (?:error|status)\b|error (?:sending request|decoding response)\b|stream errored before completion\b|network error\b|fetch failed\b|request timed out\b|the (?:requested|selected) model\b.{0,100}\b(?:not found|not available|does not exist|not supported)\b)/i;

export function providerRetryMatches(session, report, expected) {
  const issue = providerIssue(session?.provider_issue);
  return !!(expected && session?.status === 'waiting' && providerIssueInfo(issue)?.retryable
    && issue.code === expected.code && report?.id === expected.reportId);
}

export function detectProviderIssue(screen, { tool } = {}) {
  const text = stripAnsi(String(screen || '')).replace(/\r/g, '').slice(-24000);
  const frame = tool === 'claude' ? claudeTerminalFrame(text) : null;
  let raw = (frame?.body ?? text).split('\n');
  // Everything after the last native composer marker is UNSENT text, including wrapped drafts.
  // Never scan it for errors. Numbered menu options are not a composer.
  if (!frame) {
    const composer = raw.findLastIndex(line => /^\s*[›❯]\s/.test(line) && !/^\s*[›❯]\s*\d+[.)]\s/.test(line));
    // While working, a submitted transcript prompt can be the last › in the viewport. Do not cut
    // off the healthy output/spinner below it and resurrect the preceding failure.
    const after = composer >= 0 ? raw.slice(composer + 1).join('\n') : '';
    if (composer >= 0 && !/^\s*[•⏺⎿].+/m.test(after) && !/esc(?:ape)? to interrupt/i.test(after)) raw = raw.slice(0, composer);
  }
  // Quoted fixtures, JSON, code fences and prose about an error must not become live blockers.
  const continuations = new Set(raw.filter(line => /^\s{2,}\S/.test(line)).map(line => line.trim()));
  let fenced = false;
  const lines = raw.map(line => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return '\u0000'; }
    return fenced ? '\u0000' : line.trim();
  }).filter(line => line && !CHROME.test(line)).slice(-40);
  let retrying = false;
  if (RETRY.test(lines.at(-1) || '')) { retrying = true; lines.pop(); }
  if (!retrying && /\besc(?:ape)? to interrupt\b/i.test(lines.at(-1) || '')) return null;
  // Only the final actual output may be a failure. A later successful answer/tool call clears it.
  // Join a few screen-wrapped lines, without allowing arbitrary preceding/succeeding prose.
  for (let count = 1; count <= Math.min(4, lines.length); count++) {
    const tail = lines.slice(-count).join(' ').replace(/\s+/g, ' ');
    let plain = tail.replace(/^[■⏺⎿✘✖⚠×]\s*/, '');
    const suffix = plain.match(/\s+[·—–]\s*((?:Retrying|Reconnecting)\b.*)$/i);
    const inlineRetry = !!suffix && RETRY.test(suffix[1]);
    if (inlineRetry) plain = plain.slice(0, suffix.index).trim();
    if (!CAPACITY.test(plain) && !API_ERROR.test(plain) && !TRANSPORT_ERROR.test(plain)) continue;
    if (!CAPACITY.test(plain) && count > 1 && !lines.slice(-count + 1).every(line => continuations.has(line))) continue;
    if (ERR_CLEARED_RX.test(plain)) continue;
    // A new tool/bullet below the failure is not a wrapped continuation of the error.
    if (count > 1 && lines.slice(-count + 1).some(line => /^[■⏺⎿•✘✖⚠×›❯]/.test(line))) continue;
    if (frame?.processing && !retrying && !inlineRetry) return null;
    return providerIssueFromError(plain, { retrying: retrying || inlineRetry });
  }
  return null;
}
