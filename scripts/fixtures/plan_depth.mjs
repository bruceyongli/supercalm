// Public Supervisor Gym oracle for choosing control depth. The two clauses are
// intentionally independent: a response must classify the work as bounded AND
// replace ceremony with direct, focused verification.
export const BOUNDED_TASK_SCOPE_RX = /simple|one-line|small|reversible|overkill|unnecessary|disproportionate|minimal|single\s+bounded/i;
export const FOCUSED_EXECUTION_RX = /direct|focused (?:test|assertion)|relevant test|no (?:six|phase)|per-phase|waive/i;

export function planDepthResponseAccepted(text) {
  return BOUNDED_TASK_SCOPE_RX.test(text) && FOCUSED_EXECUTION_RX.test(text);
}

