// Deterministic feature bootstrap. The HTTP listener may come up early so a process supervisor can
// distinguish "alive and starting" from "not running", but application traffic remains gated until
// this loader has completed every module in declaration order.
export function createBootState(startedAt = Date.now()) {
  return {
    phase: 'loading',
    ready: false,
    startedAt,
    completedAt: null,
    loaded: [],
    failed: null,
  };
}

export async function loadSequentially(modules, {
  load = (specifier) => import(specifier),
  state = createBootState(),
} = {}) {
  for (const specifier of modules) {
    try {
      await load(specifier);
      state.loaded.push(specifier);
    } catch (error) {
      state.phase = 'failed';
      state.failed = {
        module: specifier,
        message: String(error?.message || error || 'unknown startup failure'),
      };
      state.completedAt = Date.now();
      throw error;
    }
  }
  state.phase = 'ready';
  state.ready = true;
  state.completedAt = Date.now();
  return state;
}

export function bootPayload(state, extra = {}) {
  return {
    ...extra,
    ready: !!state.ready,
    phase: state.phase,
    loadedFeatures: state.loaded.length,
    startupMs: Math.max(0, Number((state.completedAt || Date.now()) - state.startedAt)),
    ...(state.failed ? { failedFeature: state.failed.module, error: state.failed.message } : {}),
  };
}

export function trafficAllowed(pathname, state) {
  return !!state.ready || pathname === '/healthz' || pathname === '/readyz';
}
