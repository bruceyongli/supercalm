import assert from 'node:assert/strict';
import { buildProductAuditSpec, normalizeProductAuditSpec } from '../src/agents/product_audit.js';

{
  const spec = buildProductAuditSpec(`
    'Start delete session' button is clickable and starts the delete flow.
    Devices page right panel scrolls independently without triggering full-page scroll.
    Audit page content displays correctly.
    Side panel visual issues from the screenshot are fixed.
  `);
  assert(spec, 'admin visual work should request a product audit');
  assert(spec.surfaces.includes('devices'));
  assert(spec.surfaces.includes('audit'));
  assert(spec.surfaces.includes('users'), 'full admin/page review should include users coverage');
  assert(spec.interactions.includes('Start delete session'));
  assert.equal(spec.checkScroll, true);
  assert.equal(spec.checkVisual, true);
}

{
  assert.equal(buildProductAuditSpec('Refactor a database helper and update docs'), null);
}

{
  const spec = normalizeProductAuditSpec({
    surfaces: ['Devices', 'devices', 'Audit!', ''],
    interactions: ['  Start delete session  ', 'Start delete session'],
  });
  assert.deepEqual(spec.surfaces, ['devices', 'audit']);
  assert.deepEqual(spec.interactions, ['Start delete session']);
}

console.log('product_audit.test ok');
