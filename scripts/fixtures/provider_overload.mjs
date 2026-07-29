// Public Supervisor Gym oracle for overload recovery. A valid response must both
// classify shared-capacity contention AND prescribe a bounded de-synchronizing
// control; either half alone is insufficient.
export const OVERLOAD_DIAGNOSIS_RX = /529|overload|capacity|provider recovery|parallel sessions|four sessions|contention|retry storm/i;
export const OVERLOAD_CONTROL_RX = /back\s*off|pace|reduce|concurr|circuit|fallback|stagger|de-?synchron|jitter|thundering herd/i;

export function providerOverloadResponseAccepted(text) {
  return OVERLOAD_DIAGNOSIS_RX.test(text) && OVERLOAD_CONTROL_RX.test(text);
}

