import { topProviderModels } from '../../model_catalog.js';

export const SUPERVISOR_MODEL_PROVIDERS = ['codex', 'claude', 'aliyun'];
export const SUPERVISOR_MODELS_PER_PROVIDER = 3;

// Keep the watched session's own provider last so a provider-wide outage cannot blind both the
// worker and its Supervisor. For other tools, follow the operator's OpenAI → Claude → Aliyun order.
export function supervisorProviderOrder(tool) {
  if (tool === 'codex') return ['claude', 'aliyun', 'codex'];
  if (tool === 'claude') return ['codex', 'aliyun', 'claude'];
  return [...SUPERVISOR_MODEL_PROVIDERS];
}

export function automaticSupervisorChain(tool, { liveOnly = true } = {}) {
  const order = supervisorProviderOrder(tool);
  const select = (onlyLive) => order.flatMap((provider) =>
    topProviderModels(provider, SUPERVISOR_MODELS_PER_PROVIDER, { liveOnly: onlyLive }).map((model) => model.id)
  );
  const live = select(liveOnly);
  // A fully offline/startup catalog still gets a usable known chain; as soon as the hourly/live scan
  // publishes reachable providers, the next Supervisor tick recomputes from those current results.
  return live.length || !liveOnly ? live : select(false);
}
