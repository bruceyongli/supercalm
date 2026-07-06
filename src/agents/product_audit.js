const SURFACE_RULES = [
  ['overview', /\boverview\b/i],
  ['users', /\busers?\b|user details?|roster/i],
  ['invites', /\binvites?\b/i],
  ['devices', /\bdevices?\b|nodes?\b|right panel/i],
  ['provisioning', /\bprovisioning\b|workspace setup|setup workspace/i],
  ['security', /\bsecurity\b|sessions?\b|passcodes?\b/i],
  ['audit', /\baudit\b|events?\b/i],
];

const INTERACTION_RULES = [
  ['Start delete session', /start delete session/i],
  ['Delete user', /\bdelete user\b|\bhard[- ]delete\b/i],
  ['Disable user', /\bdisable user\b/i],
  ['Setup workspace', /\bsetup workspace\b|\bstart setup\b/i],
];

const VISUAL_RX = /\b(ui|ux|visual|screenshot|render|layout|style|styling|polish|ugly|side panel|sidebar|right panel|scroll|clickable|full test|full proof|page)\b/i;
const ADMIN_RX = /\badmin\b|admin panel|operations|devices?|audit|invites?|users?|delete session/i;

function uniq(list, max = 8) {
  return [...new Set(list.filter(Boolean))].slice(0, max);
}

export function buildProductAuditSpec(text = '') {
  const t = String(text || '');
  if (!VISUAL_RX.test(t) && !ADMIN_RX.test(t)) return null;

  const surfaces = [];
  const interactions = [];
  for (const [name, rx] of SURFACE_RULES) if (rx.test(t)) surfaces.push(name);
  for (const [label, rx] of INTERACTION_RULES) if (rx.test(t)) interactions.push(label);

  // Admin product work often needs a broad pass. If the operator asked for full-page/admin UI review,
  // walk the core workspaces even when the doc did not spell each one out.
  if (ADMIN_RX.test(t) && /\b(full|pages?|all|review|proof|test|macos|settings|side panel|sidebar)\b/i.test(t)) {
    surfaces.push('users', 'devices', 'audit');
  }

  const spec = {
    surfaces: uniq(surfaces, 6),
    interactions: uniq(interactions, 5),
    checkScroll: /\bscroll|right panel|devices?\b/i.test(t),
    checkVisual: VISUAL_RX.test(t),
  };
  if (!spec.surfaces.length && !spec.interactions.length && !spec.checkScroll && !spec.checkVisual) return null;
  return spec;
}

export function normalizeProductAuditSpec(spec = null) {
  if (!spec || typeof spec !== 'object') return null;
  return {
    surfaces: uniq(Array.isArray(spec.surfaces) ? spec.surfaces.map((s) => String(s || '').toLowerCase().replace(/[^a-z0-9 -]/g, '').trim()) : [], 6),
    interactions: uniq(Array.isArray(spec.interactions) ? spec.interactions.map((s) => String(s || '').replace(/\s+/g, ' ').trim()) : [], 5),
    checkScroll: spec.checkScroll !== false,
    checkVisual: spec.checkVisual !== false,
  };
}
