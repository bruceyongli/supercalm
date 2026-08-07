import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const wrapper = join(ROOT, 'scripts', 'guard-bin', 'curl');
const root = mkdtempSync(join(tmpdir(), 'aios-session-hygiene-'));
const fakeBin = join(root, 'bin');
mkdirSync(fakeBin);
const fakeCurl = join(fakeBin, 'curl');
writeFileSync(fakeCurl, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
chmodSync(fakeCurl, 0o755);

function run(args) {
  return spawnSync(wrapper, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dirname(wrapper)}:${fakeBin}:${process.env.PATH || ''}`,
      AIOS_URL: 'http://127.0.0.1:8793',
      AIOS_SESSION_ID: 's_parent_fixture',
    },
  });
}

let result = run(['-X', 'POST', 'http://127.0.0.1:8793/api/session', '-d', '{}']);
assert.equal(result.status, 0);
assert.match(result.stdout, /x-aios-parent-session: s_parent_fixture/,
  'agent curl calls that register sessions automatically carry parent ownership');

result = run(['https://example.com/api/session']);
assert.equal(result.status, 0);
assert.doesNotMatch(result.stdout, /x-aios-parent-session/,
  'the session id is never leaked to non-AIOS curl requests');

const sessions = readFileSync(join(ROOT, 'src', 'sessions.js'), 'utf8');
assert.match(sessions, /\/api\/session\/:id\/child/,
  'AIOS exposes one parent-owned child-session endpoint');
assert.match(sessions, /temporary_project=true[\s\S]*automatically removes/,
  'every launched agent receives the temporary-project cleanup contract');
assert.match(sessions, /lifecycle: parent \? 'temporary' : 'persistent'/,
  'fallback generic session launches from agent curl cannot create permanent list clutter');
assert.match(sessions, /AIOS_SESSION_TMPDIR[\s\S]*AIOS_SESSION_ARTIFACTS/,
  'every agent receives separate disposable and durable session storage instructions');
assert.match(sessions, /guardAgentArgv\(TOOLS\[tool\]\.argv/,
  'the outer agent process receives the home-root creation boundary');
assert.match(sessions, /scheduleSessionStorageCleanup\(entry\.id\)/,
  'an unexpected agent exit cleans its managed scratch directory');

rmSync(root, { recursive: true, force: true });

console.log('session_hygiene_guard.test ok');
