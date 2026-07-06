import assert from 'node:assert/strict';
import {
  activePreviewProfiles,
  hasPreviewCredentials,
  hasPreviewTargets,
  mergePreviewProfileSecrets,
  normalizePreviewProfiles,
  redactPreviewConfig,
} from '../src/preview_profiles.js';

const legacy = normalizePreviewProfiles({
  preview_url: 'https://agent.openhand.ai/',
  preview_passcode_gated: true,
  preview_username: 'user@example.com',
  preview_passcode: 'secret',
});
assert.equal(legacy.length, 1);
assert.equal(legacy[0].id, 'default');
assert.equal(legacy[0].url, 'https://agent.openhand.ai/');
assert.equal(legacy[0].passcode_gated, true);
assert.equal(legacy[0].passcode, 'secret');

const redacted = redactPreviewConfig({
  preview_passcode: 'legacy-secret',
  preview_profiles: [
    { id: 'dev', label: 'Dev', url: 'http://127.0.0.1:3000', passcode: 'dev-secret' },
    { id: 'prod', label: 'Prod', url: 'https://example.com', passcode_set: true },
  ],
});
assert.equal(redacted.preview_passcode, undefined);
assert.equal(redacted.preview_passcode_set, true);
assert.equal(redacted.preview_profiles[0].passcode, undefined);
assert.equal(redacted.preview_profiles[0].passcode_set, true);
assert.equal(redacted.preview_profiles[1].passcode_set, true);

const merged = mergePreviewProfileSecrets(
  { preview_profiles: [{ id: 'dev', url: 'http://old', passcode: 'saved-pass' }] },
  { preview_profiles: [{ id: 'dev', url: 'http://new', label: 'Dev' }] }
);
assert.equal(merged.preview_profiles[0].passcode, 'saved-pass');

const migratedSecret = mergePreviewProfileSecrets(
  { preview_url: 'https://agent.openhand.ai/', preview_passcode_gated: true, preview_passcode: 'legacy-pass' },
  { preview_profiles: [{ id: 'default', url: 'https://agent.openhand.ai/', passcode_gated: true }] }
);
assert.equal(migratedSecret.preview_profiles[0].passcode, 'legacy-pass');

const normalizedMigrated = normalizePreviewProfiles({
  preview_url: 'https://agent.openhand.ai/admin',
  preview_passcode_gated: true,
  preview_username: 'admin',
  preview_passcode: 'legacy-admin-pass',
  preview_profiles: [{ id: 'default', label: 'Default', url: 'https://agent.openhand.ai/admin', enabled: true, passcode_gated: true }],
});
assert.equal(normalizedMigrated[0].passcode, 'legacy-admin-pass');
assert.equal(normalizedMigrated[0].username, 'admin');
assert.equal(hasPreviewCredentials({ preview_url: 'https://agent.openhand.ai/admin', preview_passcode_gated: true, preview_passcode: 'legacy-admin-pass', preview_profiles: normalizedMigrated }), true);

const active = activePreviewProfiles({
  preview_profiles: [
    { id: 'dev', url: 'http://127.0.0.1:3000', enabled: true },
    { id: 'rc', url: 'https://rc.example.com', enabled: false },
    { id: 'prod', url: 'https://example.com', enabled: true, passcode_gated: true, passcode: 'prod-pass' },
  ],
});
assert.deepEqual(active.map((p) => p.id), ['dev', 'prod']);
assert.equal(hasPreviewCredentials({ preview_profiles: active }), true);
assert.equal(hasPreviewTargets({ preview_url: 'https://legacy.example.com' }), true);
assert.equal(hasPreviewTargets({ preview_url: 'https://legacy.example.com', preview_profiles: [{ id: 'prod', url: 'https://example.com', enabled: false }] }), false);

console.log('preview_profiles.test ok');
