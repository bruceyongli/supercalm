// Poll-loop wiring for the terminal-pattern classifier. The classifier itself is a PURE module
// (detect_classify.js) with no store/server imports, so it can be unit-tested without booting the
// service; this file just registers it and re-exports the hook-state setters hooks.js consumes.
import { setClassifier } from './sessions.js';
import { classify, setHookState, clearHookState } from './detect_classify.js';

export { classify, setHookState, clearHookState };

setClassifier(classify);
console.log('[aios] detector active (idle+pattern)');
