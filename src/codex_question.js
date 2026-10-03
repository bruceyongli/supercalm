// Native Codex question contracts. Async tools acknowledge delivery, not an operator answer.
export function codexQuestionCall(payload) {
  const name = String(payload?.name || '').split('.').at(-1);
  if (payload?.type !== 'function_call' || !['request_user_input', 'request_user_input_async'].includes(name)) return null;
  let args;
  try { args = typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : payload.arguments; } catch { return null; }
  if (!args || typeof args !== 'object') return null;
  const mode = name.endsWith('_async') ? 'async' : 'blocking';
  const raw = Array.isArray(args.questions) && args.questions.length ? args.questions : [args];
  const questions = raw.slice(0, 8).map((q, index) => ({
    id: String(q.id || index),
    header: String(q.header || '').slice(0, 100),
    question: String(q.question || q.title || q.prompt || 'Needs your decision').slice(0, 4000),
    multiSelect: !!(q.multiSelect || q.multi_select),
    options: (Array.isArray(q.options) ? q.options : []).slice(0, 16).map(o => typeof o === 'string'
      ? { label: o.slice(0, 1000) }
      : { label: String(o?.label || o?.key || '').slice(0, 1000), ...(o?.key != null ? { key: String(o.key) } : {}), description: String(o?.description || '').slice(0, 2000) }),
  }));
  return { id: payload.call_id, mode, questions };
}

export function questionMirror(questions) {
  return questions.map(q => [q.question, ...q.options.map(o => `- ${o.label}`)].join('\n')).join('\n\n');
}

export function storedQuestion(session) {
  try { return typeof session?.structured_question === 'string' ? JSON.parse(session.structured_question) : session?.structured_question || null; } catch { return null; }
}

export function questionEvents(prompt) {
  return (prompt?.questions || []).map((q, index) => ({
    kind: 'ask', ts: prompt.ts, askId: prompt.id, askMode: prompt.mode,
    questionId: q.id, questionIndex: index,
    title: q.header ? `Needs your decision — ${q.header}` : 'Needs your decision',
    body: q.question, options: q.options, multiSelect: q.multiSelect,
    answered: !!prompt.answered, answeredWith: prompt.answeredWith,
  }));
}

export function questionProjection(session) {
  const prompt = storedQuestion(session);
  const pending = prompt?.mode === 'async' && !prompt.answered && session.status !== 'exited';
  return {
    pending_input: !!pending,
    ...(pending ? { category: 'decision', question: prompt.questions.map(q => q.question).join('\n'),
      summary: 'The agent has a question for you.', option_events: questionEvents(prompt) } : { option_events: [] }),
  };
}
