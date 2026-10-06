import { setTimeout as sleep } from 'node:timers/promises';
import { operatorInputDisposition, pendingComposerDraft, pendingDraftMatches } from './agent_input_ready.js';

// Keep complete clear/paste/submit transactions from different senders from interleaving. Raw human
// terminal typing is deliberately not queued: the confirmation loop detects a changed draft instead.
const sends = new Map();
export async function serializeAgentInput(pane, operation) {
  const previous = sends.get(pane) || Promise.resolve();
  const run = previous.then(operation, operation);
  const settled = run.catch(() => {});
  sends.set(pane, settled);
  try { return await run; }
  finally { if (sends.get(pane) === settled) sends.delete(pane); }
}

// tmux accepting a key is not a delivery receipt. First observe our text in the live composer, then
// submit it and observe that composer clear/advance. An ignored Enter gets an Enter-only retry, never
// a second paste. Unknown or changed inputs are left alone; callers must retain the unsent message.
export async function submitAgentComposer({
  text, before = '', readScreen, pressEnter,
  confirmSubmission = null,
  pause = sleep, clock = Date.now,
  initialDelayMs = 320, timeoutMs = 5000, retryMs = 800, maxAttempts = 3,
}) {
  const deadline = clock() + timeoutMs;
  const draftOptions = { requireFooter: true, maxLines: 120, preserveWraps: true, expectedText: text };
  const beforeDraft = pendingComposerDraft(before, draftOptions)?.text || '';
  let observed = false;
  let attempts = 0;
  let lastEnter = -Infinity;
  let stableDraft = '';
  let stableCount = 0;
  let changedDraft = '', changedAt = 0, changedCount = 0;
  let pending = '';
  await pause(Math.max(0, initialDelayMs));
  do {
    if (attempts > 0 && confirmSubmission) {
      const native = await confirmSubmission().catch(() => null);
      if (native) return { accepted: true, verified: true, attempts, ...native };
    }
    const screen = await readScreen();
    const draft = pendingComposerDraft(screen, draftOptions);
    if (!draft) { changedDraft = ''; changedCount = 0; }
    // Explicitly sending a phrase which is also a CLI hint is still valid operator input.
    const withHint = draft || pendingComposerDraft(screen, { ...draftOptions, includePlaceholders: true });
    pending = draft?.text || '';
    const ownText = pendingDraftMatches(withHint?.text, text, withHint?.lines);
    // Large pastes may be folded by the CLI. Only a NEW paste token, introduced by this transaction,
    // counts; an old folded draft cannot authorize submitting somebody else's text.
    const newPaste = draft && /^\[Pasted (?:text|content)[^\]]*\]$/i.test(draft.text) && draft.text !== beforeDraft;
    if (ownText || newPaste) {
      changedDraft = ''; changedCount = 0;
      observed = true;
      const current = withHint.text;
      stableCount = stableDraft === current ? stableCount + 1 : 1;
      stableDraft = current;
      if (attempts < maxAttempts && (attempts === 0 || (stableCount >= 2 && clock() - lastEnter >= retryMs))) {
        await pressEnter();
        attempts++;
        lastEnter = clock();
        stableCount = 0;
      }
    } else if (draft) {
      // Slow/multiline pastes appear a few characters at a time. Their first
      // frame is not somebody else's edited draft: wait until our complete text
      // is visible. Never press Enter on the partial prefix itself.
      const pasteInProgress = !observed && attempts === 0
        && pendingDraftMatches(draft.text, text, draft.lines, { prefix: true });
      // A redraw can still show the pre-paste draft briefly. Wait for our text instead of pressing
      // Enter on it, but stop if a genuinely different new input settles.
      if (!pasteInProgress && (observed || draft.text !== beforeDraft)) {
        // capture-pane can catch a TUI midway through repainting a multiline composer: old rows
        // temporarily duplicate attachment lines or leave a stale suffix. An unmatched FRAME
        // isn't an edited draft. Require it to settle before aborting; never press Enter on it.
        if (changedDraft !== draft.text) { changedDraft = draft.text; changedAt = clock(); changedCount = 1; }
        else changedCount++;
        stableCount = 0;
        if (changedCount >= 2 && clock() - changedAt >= 480 && (!confirmSubmission || clock() >= deadline)) {
          return { accepted: false, reason: 'input-changed', pendingDraft: pending, attempts };
        }
      } else { changedDraft = ''; changedCount = 0; }
    } else if (observed && attempts > 0) {
      const state = operatorInputDisposition(screen, { allowActive: true, menuAnswer: true });
      if (state.ready) return { accepted: true, verified: true, attempts };
    }
    if (clock() >= deadline) break;
    await pause(Math.min(160, deadline - clock()));
  } while (clock() <= deadline);
  return { accepted: false, reason: 'submit-unconfirmed', pendingDraft: pending, attempts };
}
