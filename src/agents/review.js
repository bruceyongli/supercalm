// Council Review — an operator-invoked, read-only sidecar for answering one practical question:
// what would help this session move autonomously? It reuses Council's grounded context assembly and
// advisor model, but deliberately exposes no send-input capability and has no background tick.
// The browser may offer an explicit "Send to agent" button through the normal operator input route;
// this module itself can never steer or interrupt the coding agent.
import * as council from './council.js';

const REVIEW_PREFIX = 'Autonomy review · ';

export const actions = {
  'review-list'(ctx) {
    return {
      reviews: council.listThreads(ctx.sessionId)
        .filter((thread) => thread.kind === 'review' && String(thread.title || '').startsWith(REVIEW_PREFIX))
        .slice(0, 12),
    };
  },
  'review-thread'(ctx, body) {
    const thread = council.threadView(body?.threadId);
    if (!thread || thread.sessionId !== ctx.sessionId) throw new Error('no such review');
    return { thread };
  },
  async 'review-run'(ctx, body) {
    const projectId = ctx.project()?.id || ctx.session()?.project_id || null;
    const focus = String(body?.focus || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    const title = `${REVIEW_PREFIX}${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    let thread = council.openThread({ projectId, sessionId: ctx.sessionId, title });
    thread = council.renameThread(thread.id, title); // fixes the title and avoids an extra auto-name call
    thread = council.setKind(thread.id, 'review');
    const topic = [
      'Review this coding session for autonomous progress.',
      'Do not repeat the report or terminal. Identify the highest-leverage issue, whether human attention is truly required, and the smallest concrete instruction that would help the agent continue.',
      'Separate observed facts from inference. If no intervention is useful, say so clearly.',
      focus ? `Operator focus: ${focus}` : '',
    ].filter(Boolean).join(' ');
    const requestedModel = String(body?.model || '').trim();
    const result = await council.runRound(ctx, {
      threadId: thread.id,
      models: [requestedModel || council.COUNCIL_DEFAULT_MODELS[0]].filter(Boolean),
      topic,
    });
    const advice = (result.round || []).find((item) => item.content);
    return {
      thread: result.thread,
      review: advice?.content || '',
      model: advice?.model || '',
      error: advice ? '' : (result.round || []).map((item) => item.error).filter(Boolean).join('; '),
    };
  },
};

export const meta = {
  id: 'review',
  name: 'Council Review',
  version: '1.0.0',
  description: 'A read-only Council pass over the current session. It drafts advice for you and cannot message the working agent.',
  kind: 'view',
  scope: 'session',
  capabilities: ['read-context', 'model-calls'],
  ui: { tab: 'Review', order: 36 },
  defaultEnabled: false,
  appliesTo: () => 0,
};
