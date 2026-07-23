// One navigation seam for code-triggered app moves. The SPA router registers its handler once;
// standalone/legacy pages keep a safe real-navigation fallback. Keeping this separate avoids a
// router <-> shell import cycle while ensuring buttons behave like intercepted in-app links.
let handler = null;

export function setNavigationHandler(fn) {
  handler = typeof fn === 'function' ? fn : null;
}

export function navigate(href, opts) {
  if (handler) return handler(href, opts);
  location.href = href;
}
