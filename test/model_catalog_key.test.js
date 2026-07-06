import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const oldHome = process.env.HOME;
const oldAiosProxyKey = process.env.AIOS_PROXY_KEY;
const oldLocalProviderProxyKey = process.env.LOCAL_PROVIDER_PROXY_KEY;

const home = mkdtempSync(join(tmpdir(), 'aios-model-key-'));

try {
  delete process.env.AIOS_PROXY_KEY;
  delete process.env.LOCAL_PROVIDER_PROXY_KEY;
  process.env.HOME = home;
  writeFileSync(join(home, '.dev.vars'), 'LOCAL_PROVIDER_PROXY_KEY=local-provider-test-key\n');

  const mod = await import(`../src/model_catalog.js?case=${Date.now()}`);
  assert.equal(await mod.fleetKey(), 'local-provider-test-key');

  process.env.AIOS_PROXY_KEY = 'explicit-aios-key';
  assert.equal(await mod.fleetKey(), 'explicit-aios-key');

  console.log('model_catalog_key.test ok');
} finally {
  if (oldHome == null) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldAiosProxyKey == null) delete process.env.AIOS_PROXY_KEY;
  else process.env.AIOS_PROXY_KEY = oldAiosProxyKey;
  if (oldLocalProviderProxyKey == null) delete process.env.LOCAL_PROVIDER_PROXY_KEY;
  else process.env.LOCAL_PROVIDER_PROXY_KEY = oldLocalProviderProxyKey;
  rmSync(home, { recursive: true, force: true });
}
