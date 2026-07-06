const LOCAL_PROXY_RX = /(?:~\/proxy|127\.0\.0\.1:8788|localhost:8788|:8788\b|codex proxy)/i;
const AUTH_RX = /\b(?:401|unauthorized|oauth|re-?auth|login|not signed in|not logged in|invalid_request_error)\b/i;
const MODEL_REVIEW_RX = /\b(?:gpt-?5\.5|design review|functional review|model review|review artifacts?|studio-gpt-review\.mjs)\b/i;

export function proxyAuthRecoveryMessage(text = '', { selfUrl = 'http://127.0.0.1:8793' } = {}) {
  const t = String(text || '');
  if (!LOCAL_PROXY_RX.test(t) || !AUTH_RX.test(t) || !MODEL_REVIEW_RX.test(t)) return '';
  const base = String(selfUrl || 'http://127.0.0.1:8793').replace(/\/$/, '');
  const chatUrl = `${base}/api/cli-proxy/v1/chat/completions`;
  const v1Url = `${base}/api/cli-proxy/v1`;
  const scriptMatch = t.match(/\bnode\s+([^\s'"`]*studio-gpt-review\.mjs)\b/i);
  const command = scriptMatch
    ? `PROXY_URL=${chatUrl} node ${scriptMatch[1]}`
    : `Use the Supercalm OpenAI-compatible proxy at ${v1Url} with model gpt-5.5. If the script accepts PROXY_URL, set PROXY_URL=${chatUrl}.`;
  return [
    'Do not stop on the unauthorized local ~/proxy/:8788 route. Supercalm already exposes the requested model through its working proxy.',
    `Run: ${command}`,
    'Then triage the review, implement applicable fixes, rerun the relevant build/tests/product walkthrough, commit the changes, and report final evidence. Only keep this blocked if the Supercalm proxy command also fails, and include the exact output.',
  ].join(' ');
}
