import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { danglingAlias, waitForStorageAlias } from '../src/boot_storage_gate.js';

test('boot waits for an unmounted storage alias instead of failing, without a local fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'aios-boot-gate-'));
  try {
    const mount = join(root, 'mount'), target = join(mount, 'logs'), alias = join(root, 'logs');
    symlinkSync(target, alias);
    assert.equal(danglingAlias(alias), true);
    let now = 0, sleeps = 0; const lines = [];
    const waited = waitForStorageAlias(alias, {
      pollMs: 2000, remindMs: 4000, clock: () => now, log: line => lines.push(line),
      sleep: ms => { now += ms; if (++sleeps === 3) mkdirSync(target, { recursive: true }); },
    });
    assert.equal(waited, 6000);
    assert.equal(sleeps, 3);
    assert.equal(danglingAlias(alias), false);
    assert.match(lines[0], /waiting for live storage/);
    assert.equal(lines.filter(line => /still waiting/.test(line)).length, 1);
    assert.match(lines.at(-1), /available after 6s/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ordinary, missing and mounted directories pass straight through', () => {
  const root = mkdtempSync(join(tmpdir(), 'aios-boot-gate-'));
  try {
    const real = join(root, 'real'), live = join(root, 'live');
    mkdirSync(real); symlinkSync(real, live);
    for (const path of [real, live, join(root, 'absent')]) {
      assert.equal(waitForStorageAlias(path, { sleep: () => assert.fail('must not wait'), log: () => assert.fail('must not log') }), 0);
    }
    assert.equal(existsSync(join(root, 'absent')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('store gates on the log alias and the watcher lets a slow image attach finish', () => {
  const store = readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
  assert.ok(store.indexOf('waitForStorageAlias(LOG_DIR)') < store.indexOf('mkdirSync(LOG_DIR'));
  const watcher = readFileSync(new URL('../bin/storage-mount-watch.mjs', import.meta.url), 'utf8');
  assert.match(watcher, /'attach'[^\n]*timeout: ATTACH_TIMEOUT_MS/);
  assert.match(watcher, /ATTACH_TIMEOUT_MS = Math\.max\(60000,[^\n]*45 \* 60000\)/);
});
