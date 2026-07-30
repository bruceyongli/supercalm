// Scenario 32 requires preserving the task contract while removing an oversized attachment.
// Accept either an explicit splitting/compaction operation or a fresh request that carries only
// the minimal relevant working context. Diagnosis alone ("the payload is too large") is not enough.
export const REQUEST_REDUCTION_RX = /split|chunk|compact|trim|select|targeted|excerpt|retrieve|without attach|do not attach|extract|summar|small working|minimal(?:ly)?(?:\s+\w+){0,2}\s+relevant/i;
