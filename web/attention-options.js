// Structured option prompts for the Needs-you inbox. The lean home endpoint intentionally stays
// database-only; only the small set of visible attention cards asks the cached story API for the CLI's
// native request_user_input / AskUserQuestion payload.
import { api } from './common.js';

const promptCache = new Map(); // sid -> { reportKey, questions, promise }

export function attentionReportKey(session) {
  return String(session?.last_key?.id || session?.last_activity || '');
}

function normalizedOption(option, index) {
  if (typeof option === 'string') return { key: '', label: option, description: '', index };
  return {
    key: option?.key == null ? '' : String(option.key),
    label: String(option?.label || option?.spoken || option?.key || `Option ${index + 1}`),
    description: String(option?.description || ''),
    index,
  };
}

export function extractPendingOptionQuestions(events) {
  const pending = (events || []).filter((event) => event?.kind === 'ask' && !event.answered && Array.isArray(event.options) && event.options.length);
  if (!pending.length) return [];
  const latest = pending[pending.length - 1];
  // Multi-question AskUserQuestion events share an askId. Older cached/event shapes do not, so their
  // timestamp remains a safe grouping fallback.
  const samePrompt = latest.askId
    ? pending.filter((event) => event.askId === latest.askId)
    : pending.filter((event) => Number(event.ts || 0) === Number(latest.ts || 0));
  return samePrompt.map((event, index) => ({
    id: String(event.askId || `${event.ts || 0}:${index}`),
    header: String(event.title || '').replace(/^Needs your decision\s*[—-]?\s*/i, ''),
    question: String(event.body || event.title || `Question ${index + 1}`),
    multiSelect: !!event.multiSelect,
    options: event.options.map(normalizedOption),
  }));
}

export function getOptionQuestions(session) {
  const hit = promptCache.get(session?.id);
  return hit?.reportKey === attentionReportKey(session) ? hit.questions || [] : [];
}

export function ensureOptionQuestions(session, onChange) {
  if (!session?.id || session.status !== 'waiting' || !session.unread) return Promise.resolve([]);
  const reportKey = attentionReportKey(session);
  const hit = promptCache.get(session.id);
  if (hit?.reportKey === reportKey) return hit.promise || Promise.resolve(hit.questions || []);
  const entry = { reportKey, questions: [], promise: null };
  entry.promise = api(`api/session/${session.id}/story`).then((result) => {
    if (promptCache.get(session.id) !== entry) return [];
    entry.questions = extractPendingOptionQuestions(result?.events);
    entry.promise = null;
    if (entry.questions.length) onChange?.();
    return entry.questions;
  }).catch(() => {
    if (promptCache.get(session.id) === entry) entry.promise = null;
    return [];
  });
  promptCache.set(session.id, entry);
  return entry.promise;
}

export function choiceText(option) {
  return String(option?.key || option?.label || '').trim();
}

export function answersPayload(questions, selections) {
  return questions.map((question, questionIndex) => {
    const selected = selections.get(questionIndex) || new Set();
    return {
      question: question.question,
      values: [...selected].map((optionIndex) => {
        const option = question.options[optionIndex] || {};
        return { key: option.key || '', label: option.label || '' };
      }),
    };
  });
}
