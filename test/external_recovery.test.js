import assert from 'node:assert/strict';
import { proxyAuthRecoveryMessage } from '../src/agents/external_recovery.js';

{
  const msg = proxyAuthRecoveryMessage(
    'GPT-5.5 design review blocked: proxy at :8788/v1/models returns 401 Unauthorized; needs re-auth before node scripts/studio-gpt-review.mjs can run.',
    { selfUrl: 'http://127.0.0.1:8793/aios' }
  );
  assert.match(msg, /Do not stop/);
  assert.match(msg, /PROXY_URL=http:\/\/127\.0\.0\.1:8793\/aios\/api\/cli-proxy\/v1\/chat\/completions node scripts\/studio-gpt-review\.mjs/);
  assert.match(msg, /Only keep this blocked if the Supercalm proxy command also fails/);
}

{
  assert.equal(proxyAuthRecoveryMessage('Production deploy requires operator approval.'), '');
}

console.log('external_recovery.test ok');
