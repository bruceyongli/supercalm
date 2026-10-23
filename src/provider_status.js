// A live provider failure is neither an operator question nor a dead CLI. Keep this separate from
// process lifecycle so Stop/Resume, native conversation identity and queued input are unchanged.
import { stripAnsi } from './util.js';
import { claudeTerminalFrame } from './claude_lifecycle.js';

export function providerIssue(value) {
  try {
    const issue = typeof value === 'string' ? JSON.parse(value) : value;
    if (issue?.code !== 'capacity' || !['blocked', 'retrying'].includes(issue.phase)) return null;
    return { code: 'capacity', phase: issue.phase };
  } catch { return null; }
}

export function providerIssueMessage(issue) {
  return issue?.phase === 'retrying'
    ? 'Model at capacity — the CLI is retrying.'
    : 'Model at capacity. Retry later or choose another model.';
}

const CAPACITY = /^(?:[■⏺⎿✘✖⚠×]\s*)?(?:(?:API\s+)?Error:\s*)?Selected model is at capacity\.\s*Please try a different model\.?$/i;
const RETRY = /^(?:[■⏺⎿✘✖⚠×⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*)?(?:Retrying(?:\s+(?:automatically|request|in\s+\d+(?:\.\d+)?\s*(?:ms|s|seconds?|minutes?)))?|Reconnecting)(?:\s*\(?\d+\s*\/\s*\d+\)?|[. …:–—-].*)?$/i;
const CHROME = /^(?:[─━═_-]{3,}|[?？] for shortcuts.*|(?:\d+%|[\d,.]+[kKmM]?) context (?:left|used).*|(?:gpt-|claude-)[\w. /-]+|(?:shift\+tab|ctrl\+|⌃|⏵⏵|⏸).*|(?:Ask Codex to do anything|Find and fix a bug in @filename|Run \/review on my current changes)|[✻✢✽✶✳✼*]\s*\w+ for \d.*)$/i;

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
  let fenced = false;
  const lines = raw.map(line => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return '\u0000'; }
    return fenced ? '\u0000' : line.trim();
  }).filter(line => line && !CHROME.test(line)).slice(-40);
  let retrying = false;
  if (RETRY.test(lines.at(-1) || '')) { retrying = true; lines.pop(); }
  // Only the final actual output may be a failure. A later successful answer/tool call clears it.
  // Join a few screen-wrapped lines, without allowing arbitrary preceding/succeeding prose.
  for (let count = 1; count <= Math.min(4, lines.length); count++) {
    const tail = lines.slice(-count).join(' ').replace(/\s+/g, ' ');
    if (!CAPACITY.test(tail)) continue;
    if (frame?.processing && !retrying) return null;
    return { code: 'capacity', phase: retrying ? 'retrying' : 'blocked' };
  }
  return null;
}
