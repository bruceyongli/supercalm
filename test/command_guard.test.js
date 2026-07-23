import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const guard = join(ROOT, 'scripts', 'aios-command-guard.sh');
const root = mkdtempSync(join(tmpdir(), 'aios-command-guard-'));
const source = join(root, 'release');
const wrong = join(root, 'shared');
const fakeBin = join(root, 'bin');
mkdirSync(source, { recursive: true });
mkdirSync(wrong, { recursive: true });
mkdirSync(fakeBin, { recursive: true });

execFileSync('git', ['-C', source, 'init', '-q', '-b', 'release']);
execFileSync('git', ['-C', source, 'config', 'user.email', 'test@example.invalid']);
execFileSync('git', ['-C', source, 'config', 'user.name', 'Test']);
writeFileSync(join(source, 'README'), 'release\n');
execFileSync('git', ['-C', source, 'add', 'README']);
execFileSync('git', ['-C', source, 'commit', '-qm', 'release']);

for (const tool of ['wrangler', 'npm']) {
  const file = join(fakeBin, tool);
  writeFileSync(file, '#!/bin/sh\nprintf "delegated:%s\\n" "$*"\n');
  chmodSync(file, 0o755);
}

function run(tool, args, { cwd = wrong, extra = {} } = {}) {
  return spawnSync(guard, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH || ''}`,
      AIOS_GUARDED_COMMAND: tool,
      AIOS_DEPLOY_SOURCE_DIR: source,
      AIOS_DEPLOY_BRANCH: 'release',
      AIOS_NO_DEPLOY: '0',
      ...extra,
    },
  });
}

let r = run('wrangler', ['--version']);
assert.equal(r.status, 0, 'ordinary commands delegate');
assert.match(r.stdout, /delegated:--version/);

r = run('wrangler', ['pages', 'deploy', 'dist']);
assert.equal(r.status, 126, 'direct wrong-tree Pages deploy blocked');
assert.match(r.stderr, /outside the declared source/);

r = run('npm', ['exec', '--prefix', wrong, 'wrangler', '--', 'pages', 'deploy', 'dist']);
assert.equal(r.status, 126, 'npm-exec Wrangler indirection blocked');

r = run('wrangler', ['pages', 'deploy', 'dist'], { cwd: source });
assert.equal(r.status, 126, 'bare vendor deploy is blocked even in the declared release tree');
assert.match(r.stderr, /bypasses the repository's reviewed release command/);

r = run('npm', ['run', 'deploy'], { cwd: source });
assert.equal(r.status, 0, 'reviewed package release command is allowed in the declared release tree');
assert.match(r.stdout, /delegated:run deploy/);

execFileSync('git', ['-C', source, 'switch', '-qc', 'stale']);
r = run('wrangler', ['deploy'], { cwd: source });
assert.equal(r.status, 126, 'wrong release branch blocked');
assert.match(r.stderr, /not the declared release branch/);

execFileSync('git', ['-C', source, 'switch', '-q', 'release']);
r = run('wrangler', ['deploy'], { cwd: source, extra: { AIOS_NO_DEPLOY: '1' } });
assert.equal(r.status, 126, 'isolated session cannot deploy even from the release tree');
assert.match(r.stderr, /isolated worktree/);

console.log('command_guard.test ok');
