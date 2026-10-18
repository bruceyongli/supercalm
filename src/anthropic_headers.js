// Claude Code can include context edits while treating a custom base URL as a generic gateway.
// Anthropic rejects that field without its beta header. Preserve the edits and all caller betas;
// never "repair" a 400 by silently dropping context-management behavior or switching models.
export function anthropicHeaders(headers, body) {
  const betas = String(headers['anthropic-beta'] || '').split(',').map(s => s.trim()).filter(Boolean);
  if (body.context_management != null && !betas.some(beta => beta.startsWith('context-management-'))) {
    betas.push('context-management-2025-06-27');
  }
  return { 'anthropic-version': headers['anthropic-version'] || '2023-06-01',
    'anthropic-beta': [...new Set(betas)].join(',') };
}
