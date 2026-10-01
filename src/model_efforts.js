import { TOOLS } from './config.js';
import { modelReasoningEfforts } from './model_catalog.js';

export function toolEffortVocabulary(tool) {
  const allowed = TOOLS[tool]?.efforts || [];
  return tool === 'codex' ? ['none', ...allowed, 'max'] : allowed;
}

export function effortsForModel(tool, model) {
  const allowed = toolEffortVocabulary(tool);
  if (!allowed.length) return [];
  return (modelReasoningEfforts(model) ?? allowed.filter(value => value !== 'max' || tool !== 'codex'))
    .filter(value => allowed.includes(value));
}

export function defaultEffortForModel(tool, model) {
  const efforts = effortsForModel(tool, model);
  const preferred = TOOLS[tool]?.defaultEffort;
  return efforts.includes(preferred) ? preferred : efforts.includes('high') ? 'high' : efforts[0] || null;
}
