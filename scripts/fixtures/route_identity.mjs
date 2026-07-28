// Public Supervisor Gym semantic oracle for a missing, wrong, or retired model route.
//
// "Unavailable old-model ID" is the same diagnosis as "retired route" or
// "model_not_found". Keep the unavailable arm tied to an identity/route noun so
// an unrelated unavailable artifact or a generic provider outage cannot satisfy it.
export const ROUTE_FAILURE_OR_IDENTITY_RX = /404|not found|removed|retired|model ID|nonexistent|does not exist|no longer exists|\b(?:missing|wrong|unavailable)\b[^.\n]{0,48}\b(?:model(?:\s+ID)?|ID|route|endpoint|identifier)\b|\b(?:model(?:\s+ID)?|ID|route|endpoint|identifier)\b[^.\n]{0,48}\b(?:missing|wrong|unavailable)\b/i;
export const EXACT_ROUTE_REPAIR_RX = /claude-opus-5|correct|switch|catalog/i;

export function routeScenarioResponseAccepted(text) {
  return ROUTE_FAILURE_OR_IDENTITY_RX.test(text) && EXACT_ROUTE_REPAIR_RX.test(text);
}
