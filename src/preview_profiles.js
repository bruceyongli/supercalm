function text(v, max = 500) {
  return String(v ?? '').replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function pid(v, fallback) {
  const s = text(v, 80).replace(/[^A-Za-z0-9_.:-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return s || fallback;
}

export function normalizePreviewProfiles(cfg = {}) {
  const raw = Array.isArray(cfg.preview_profiles) ? cfg.preview_profiles : [];
  const profiles = raw.map((p, i) => {
    const id = pid(p?.id, `preview-${i + 1}`);
    const label = text(p?.label, 80) || `Preview ${i + 1}`;
    const url = text(p?.url ?? p?.preview_url, 1000);
    const inheritsLegacy = id === 'default' || (cfg.preview_url && url && text(cfg.preview_url, 1000) === url);
    const passcode = p?.passcode ?? p?.preview_passcode ?? (inheritsLegacy ? cfg.preview_passcode : '');
    return {
      id,
      label,
      url,
      enabled: p?.enabled !== false,
      passcode_gated: !!(p?.passcode_gated ?? p?.preview_passcode_gated ?? (inheritsLegacy && cfg.preview_passcode_gated)),
      username: text(p?.username ?? p?.preview_username ?? (inheritsLegacy ? cfg.preview_username : ''), 200),
      ...(passcode ? { passcode: String(passcode) } : {}),
      ...(p?.passcode_set ? { passcode_set: true } : {}),
    };
  }).filter((p) => p.url || p.label || p.passcode_gated);

  if (!profiles.length && cfg.preview_url) {
    profiles.push({
      id: 'default',
      label: 'Default',
      url: text(cfg.preview_url, 1000),
      enabled: true,
      passcode_gated: !!cfg.preview_passcode_gated,
      username: text(cfg.preview_username, 200),
      ...(cfg.preview_passcode ? { passcode: String(cfg.preview_passcode) } : {}),
    });
  }

  const seen = new Set();
  return profiles.map((p, i) => {
    let id = p.id;
    while (seen.has(id)) id = `${p.id}-${i + 1}`;
    seen.add(id);
    return { ...p, id };
  });
}

export function activePreviewProfiles(cfg = {}) {
  return normalizePreviewProfiles(cfg).filter((p) => p.enabled !== false && p.url);
}

export function hasPreviewTargets(cfg = {}) {
  const profiles = normalizePreviewProfiles(cfg);
  if (profiles.length) return profiles.some((p) => p.enabled !== false && p.url);
  return !!cfg.preview_url;
}

export function hasPreviewCredentials(cfg = {}) {
  const profiles = normalizePreviewProfiles(cfg);
  if (profiles.length) return profiles.some((p) => p.passcode_gated && p.passcode);
  return !!(cfg.preview_passcode_gated && cfg.preview_passcode);
}

export function redactPreviewConfig(cfg = {}) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  let out = cfg;
  if ('preview_passcode' in out || 'preview_passcode_set' in out) {
    out = { ...out };
    const has = !!out.preview_passcode || !!out.preview_passcode_set;
    delete out.preview_passcode;
    out.preview_passcode_set = has;
  }
  if (Array.isArray(out.preview_profiles)) {
    if (out === cfg) out = { ...out };
    out.preview_profiles = out.preview_profiles.map((p) => {
      if (!p || typeof p !== 'object') return p;
      const next = { ...p };
      const has = !!next.passcode || !!next.preview_passcode || !!next.passcode_set;
      delete next.passcode;
      delete next.preview_passcode;
      if (has) next.passcode_set = true;
      else delete next.passcode_set;
      return next;
    });
  }
  return out;
}

export function mergePreviewProfileSecrets(existing = {}, incoming = {}) {
  if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.preview_profiles)) return incoming;
  const prior = new Map(normalizePreviewProfiles(existing).map((p) => [p.id, p]));
  return {
    ...incoming,
    preview_profiles: incoming.preview_profiles.map((p, i) => {
      if (!p || typeof p !== 'object') return p;
      const id = pid(p.id, `preview-${i + 1}`);
      const prev = prior.get(id);
      if ((p.passcode || p.preview_passcode) || !prev?.passcode) return p;
      return { ...p, passcode: prev.passcode };
    }),
  };
}
