import { setTimeout as sleep } from 'node:timers/promises';
import { cleanAgentScreen, codexComposerPlaceholder } from './agent_input_ready.js';
import { terminalQuestionPrompt } from './detect_classify.js';

// One owner for clear/paste/submit. Raw terminal input is not queued; its revision invalidates
// this owner's lease. A retry retains the SAME transaction and can never repeat its paste.
const sends = new Map();
export async function serializeAgentInput(pane, operation) {
  const previous = sends.get(pane) || Promise.resolve();
  const run = previous.then(operation, operation);
  const settled = run.catch(() => {});
  sends.set(pane, settled);
  try { return await run; }
  finally { if (sends.get(pane) === settled) sends.delete(pane); }
}

// Observe structure, NOT a reconstruction of the submitted text. Wide characters, quoted prompts,
// folded pastes and viewport clipping are presentation, not transport acknowledgement.
export function observeComposer(screen, { draftFooterPattern = null } = {}) {
  const lines = cleanAgentScreen(screen).trimEnd().split('\n');
  const footer = draftFooterPattern || /^\s*(?:gpt-[\w.-]+|\d+% context left|.*\bbypass permissions|.*\bshift\+tab)/i;
  const end = lines.findLastIndex(line => footer.test(line));
  if (end < 0 || end < lines.length - 6) return { kind: 'unknown' };
  const start = lines.findLastIndex((line, i) => i < end && /^\s*[›❯](?:\s|$)/.test(line));
  if (start < 0) return { kind: 'unknown' };
  const content = [lines[start].replace(/^\s*[›❯]\s?/, ''), ...lines.slice(start + 1, end)]
    .filter(line => !/^\s*[─━═╌╍┄┅┈┉⎯_-]{8,}\s*$/.test(line)).join('\n').trim();
  const empty = !content || codexComposerPlaceholder(content) || /^(?:Ask Claude|Try ["“])/.test(content);
  return { kind: empty ? 'empty' : 'draft', text: content };
}

// Create ONLY after the complete bracketed paste write succeeds (or an exact existing draft was
// positively identified). Ownership authorizes the first Enter; screen matching does not. Native
// history/queue acknowledgement takes priority. The compatibility receipt is a positively seen
// nonempty composer clearing and remaining empty for two observations after Enter (some CLI modes
// don't persist history, or transform image paths into attachments in their native transcript).
export function createAgentSubmission({
  readScreen, pressEnter, confirmSubmission = null, inputUnchanged = () => true,
  pasteCompleted = false, pasteReady = () => true, draftFooterPattern = null,
  pause = sleep, clock = Date.now, initialDelayMs = 320, timeoutMs = 5000, retryMs = 800, maxAttempts = 3,
}) {
  let phase = 'pasted', attempts = 0, lastEnter = -Infinity, observed = false, receipt = null;
  let lastDraft = '', submittedDraft = '', stableCount = 0, emptyCount = 0;
  const trace = [];
  const transition = next => {
    phase = next;
    if (trace.length === 32) trace.shift();
    trace.push({ phase, at: clock(), attempts });
  };
  const result = (extra = {}) => ({ accepted: phase === 'accepted', verified: phase === 'accepted',
    phase, attempts, trace: trace.slice(), ...extra });
  return async function submit() {
    if (receipt) return result(receipt);
    let deadline = clock() + timeoutMs;
    const attemptLimit = attempts + maxAttempts;
    await pause(attempts ? 0 : Math.max(0, initialDelayMs));
    do {
      const native = await confirmSubmission?.().catch(() => null);
      if (native) { receipt = native; transition('accepted'); return result(native); }
      if (!pasteCompleted) return result({ reason: 'paste-unowned' });
      if (!inputUnchanged() || phase === 'interrupted') {
        transition('interrupted'); return result({ reason: 'input-changed' });
      }
      const screen = await readScreen().catch(() => '');
      if (!inputUnchanged()) { transition('interrupted'); return result({ reason: 'input-changed' }); }
      const view = observeComposer(screen, { draftFooterPattern });
      // Do not select a new permission/recovery prompt which replaced the composer. Quoted choices
      // within a live composer aren't a modal. A native receipt above still wins after manual Enter.
      if (terminalQuestionPrompt(screen)
          || /(?:^|\n)\s*enter continue\s*[·•]\s*esc quit\s*$/i.test(screen.trim())) {
        transition('interrupted'); return result({ reason: 'input-unavailable' });
      }
      if (view.kind === 'draft') {
        observed = true; emptyCount = 0;
        stableCount = lastDraft === view.text ? stableCount + 1 : 1;
        lastDraft = view.text;
      } else {
        stableCount = 0;
        emptyCount = view.kind === 'empty' ? emptyCount + 1 : 0;
      }
      if (observed && attempts && emptyCount >= 2) {
        receipt = { receipt: 'composer-cleared' }; transition('accepted'); return result(receipt);
      }
      // Claude can asynchronously expand images before adding the associated text. Its adapter
      // waits only for that known processing state, not for a byte-for-byte rendering of the input.
      const ready = pasteReady(view);
      const first = attempts === 0;
      const retry = view.kind === 'draft' && (!submittedDraft || view.text === submittedDraft)
        && stableCount >= 2 && clock() - lastEnter >= retryMs;
      if (ready && attempts < attemptLimit && (first || retry)) {
        if (!inputUnchanged()) { transition('interrupted'); return result({ reason: 'input-changed' }); }
        // Record before awaiting: a transport error is uncertain, never permission to re-paste.
        attempts++; lastEnter = clock(); submittedDraft = view.kind === 'draft' ? view.text : '';
        transition('submitted');
        // A timed-out tmux command may already have delivered its key. Reconcile the same
        // transaction/receipt; throwing into the HTTP retry path would risk a second paste.
        await pressEnter().catch(() => {});
        // Capturing a pane or reading history on remote storage may consume the initial budget.
        // Always give the first actual submit its own acknowledgement window.
        if (first) deadline = Math.max(deadline, clock() + timeoutMs);
        stableCount = 0; emptyCount = 0;
      }
      if (clock() >= deadline) break;
      await pause(Math.min(160, deadline - clock()));
    } while (clock() <= deadline);
    return result({ reason: 'submit-unconfirmed', pendingDraft: lastDraft });
  };
}

export const submitAgentComposer = options => createAgentSubmission(options)();
