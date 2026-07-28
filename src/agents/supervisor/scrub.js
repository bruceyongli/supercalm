// Supervisor text crosses several durable and operator-visible boundaries: review rows, escalation
// state, notifications, and agent sends. Keep the redaction policy dependency-free and shared so a
// new path cannot quietly use a weaker scrubber than verification provenance.
export function scrubSupervisorText(value) {
  return String(value || '')
    .replace(/data:[a-z0-9.+-]{0,40}\/[a-z0-9.+-]{0,40};base64,[A-Za-z0-9+/=]{16,}/gi, '[redacted-data-uri]')
    .replace(/\b(?:sk|pk|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{16,}/gi, '[redacted-key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, 'Bearer [redacted]');
}
