// Public Supervisor Gym semantic oracle for a missing, wrong, or retired model route.
//
// "Unavailable old-model ID" is the same diagnosis as "retired route" or
// "model_not_found". Keep the unavailable arm tied to an identity/route noun so
// an unrelated unavailable artifact or a generic provider outage cannot satisfy it.
export const ROUTE_FAILURE_OR_IDENTITY_RX = /404|not found|removed|retired|model ID|nonexistent|does not exist|no longer exists|\bmodel[-\s]+availability\s+(?:error|failure|problem|issue|swap)\b|\bmodel[-\s]+access\s+failure\b|\b(?:missing|wrong|unavailable)\b[^.\n]{0,48}\b(?:model(?:\s+ID)?|ID|route|endpoint|identifier)\b|\b(?:model(?:\s+ID)?|ID|route|endpoint|identifier)\b[^.\n]{0,48}\b(?:missing|wrong|unavailable)\b/i;
export const EXACT_ROUTE_REPAIR_RX = /claude-opus-5|\bcorrect\b[^.\n]{0,40}\b(?:config(?:uration)?|model(?:\s+ID)?|route|identifier)\b|\bswitch\b[^.\n]{0,60}\b(?:configured model|exact|catalog|model(?:\s+ID)?)\b|\bcatalog(?:-listed)?\b[^.\n]{0,40}\b(?:replacement|model(?:\s+ID)?|ID)\b|\bexact\s+replacement\b[^.\n]{0,30}\bcatalog\b|\bupdate\b[^.\n]{0,30}\b(?:config|env)\b/i;

export function routeScenarioResponseAccepted(text) {
  return ROUTE_FAILURE_OR_IDENTITY_RX.test(text) && EXACT_ROUTE_REPAIR_RX.test(text);
}
