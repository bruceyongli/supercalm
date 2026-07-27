// One renderer for every model picker. Providers are category headings; the option text is only the
// model name, so menus read "Codex → GPT-5.6 Sol" instead of repeating "Codex / …" on every row.

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function modelProviderLabel(model) {
  const raw = String(model?.providerLabel || model?.provider || 'Other');
  return raw === 'api' ? 'API' : raw.replace(/(^|[-_\s])([a-z])/g, (_, sep, char) => sep + char.toUpperCase());
}

export function modelOptionLabel(model, provider = modelProviderLabel(model)) {
  if (typeof model === 'string') return model;
  let label = String(model?.modelLabel || model?.label || model?.id || '');
  label = label.replace(new RegExp(`^${regexEscape(provider)}\\s*(?:/|:)\\s*`, 'i'), '');
  label = label.replace(new RegExp(`^${regexEscape(provider)}\\s+`, 'i'), '');
  if (model?.vision && !/\(\s*vision\s*\)$/i.test(label)) label += ' (vision)';
  return label;
}

export function groupedModelOptions(models, {
  selected = '',
  leading = [],
  custom = true,
  groupOrder = null,
} = {}) {
  const normalized = (models || []).map((model) => typeof model === 'string'
    ? { id: model, label: model, provider: 'other', providerLabel: 'Other' }
    : model).filter((model) => model?.id);
  const allIds = new Set(normalized.map((model) => String(model.id)));
  // Provider catalogs often expose aliases for the same visible model (subscription id, API id,
  // dated id). A picker is for choosing a model, not an auth route: show each provider/name once,
  // preferring the currently-selected alias so reopening the menu never changes its value.
  const byDisplay = new Map();
  for (const model of normalized) {
    const provider = modelProviderLabel(model);
    const key = `${provider.toLowerCase()}|${modelOptionLabel(model, provider).toLowerCase().replace(/\s+/g, ' ').trim()}`;
    const current = byDisplay.get(key);
    if (!current || String(model.id) === String(selected)) byDisplay.set(key, model);
  }
  const unique = [...byDisplay.values()];
  const groups = new Map();
  for (const model of unique) {
    const provider = modelProviderLabel(model);
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(model);
  }
  const lead = [...leading];
  if (custom && selected && !allIds.has(String(selected)) && !lead.some((item) => String(item.value) === String(selected))) {
    lead.push({ value: selected, label: `${selected} · custom` });
  }
  let html = lead.map((item) => {
    const value = String(item.value ?? item.id ?? '');
    const label = item.label ?? item.modelLabel ?? value;
    return `<option value="${esc(value)}" ${value === String(selected) ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
  const order = typeof groupOrder === 'function'
    ? [...groups.keys()].sort(groupOrder)
    : Array.isArray(groupOrder)
      ? [...groups.keys()].sort((a, b) => {
          const ai = groupOrder.indexOf(a);
          const bi = groupOrder.indexOf(b);
          return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
        })
      : [...groups.keys()];
  for (const provider of order) {
    html += `<optgroup label="${esc(provider)}">`;
    html += groups.get(provider).map((model) => {
      const value = String(model.id);
      const full = String(model.label || model.modelLabel || model.id);
      return `<option value="${esc(value)}" ${value === String(selected) ? 'selected' : ''} title="${esc(full)}">${esc(modelOptionLabel(model, provider))}</option>`;
    }).join('');
    html += '</optgroup>';
  }
  return html;
}
