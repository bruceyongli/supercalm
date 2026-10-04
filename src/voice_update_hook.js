// Avoid a push -> sessions -> push import cycle. Registration never starts work on its own.
let prepareUpdate = null;
export function registerVoiceUpdatePreparer(fn) { prepareUpdate = fn; }
export function prepareVoiceNotification(sessionId) { return prepareUpdate?.(sessionId) || Promise.resolve(null); }
