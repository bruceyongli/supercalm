// iOS session viewport coordination.
//
// Safari keeps a full-size layout viewport while its visual viewport shrinks and pans around the
// focused textarea. The session shell must follow that smaller rectangle while the keyboard is open,
// then immediately return to CSS 100dvh when the keyboard closes. Keeping the last visualViewport
// height inline after blur is what left the agent rail halfway up the screen with a large empty tail.

const KEYBOARD_MIN_REDUCTION = 96;

const finite = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

export function sessionViewportLayout({
  visualHeight,
  offsetTop = 0,
  offsetLeft = 0,
  baselineHeight,
  inputFocused = false,
} = {}) {
  const height = Math.max(0, finite(visualHeight));
  const baseline = Math.max(height, finite(baselineHeight, height));
  const keyboardOpen = !!inputFocused && baseline - height >= KEYBOARD_MIN_REDUCTION;
  return {
    keyboardOpen,
    height: keyboardOpen ? Math.round(height) : null,
    top: keyboardOpen ? Math.round(finite(offsetTop)) : 0,
    left: keyboardOpen ? Math.round(finite(offsetLeft)) : 0,
  };
}

export function installSessionViewportSync({
  shell,
  input,
  signal,
  onLayout = () => {},
  visualViewport = globalThis.visualViewport,
  win = globalThis.window,
  doc = globalThis.document,
  coarse = globalThis.matchMedia?.('(pointer: coarse)')?.matches,
} = {}) {
  if (!shell || !input || !visualViewport || !win || !doc || !coarse) return null;

  const layoutHeight = () => Math.max(
    finite(win.innerHeight),
    finite(doc.documentElement?.clientHeight),
    finite(visualViewport.height),
  );
  let baselineHeight = layoutHeight();
  const timers = new Map();

  const clearPinnedViewport = () => {
    shell.classList.remove('keyboard-open');
    shell.style.removeProperty('height');
    shell.style.removeProperty('transform');
  };

  const sync = () => {
    if (signal?.aborted) return;
    const focused = doc.activeElement === input;
    const observedLayoutHeight = layoutHeight();
    // Retain the pre-keyboard height while the input is focused. Once focus leaves, accept the
    // current full layout immediately even if visualViewport is still reporting its stale small size.
    baselineHeight = focused
      ? Math.max(baselineHeight, observedLayoutHeight)
      : observedLayoutHeight;
    const state = sessionViewportLayout({
      visualHeight: visualViewport.height,
      offsetTop: visualViewport.offsetTop,
      offsetLeft: visualViewport.offsetLeft,
      baselineHeight,
      inputFocused: focused,
    });
    if (state.keyboardOpen) {
      shell.classList.add('keyboard-open');
      shell.style.height = `${state.height}px`;
      shell.style.transform = `translate3d(${state.left}px, ${state.top}px, 0)`;
    } else {
      clearPinnedViewport();
    }
    try { onLayout(state); } catch {}
  };

  const later = (delay) => {
    const previous = timers.get(delay);
    if (previous) win.clearTimeout(previous);
    const timer = win.setTimeout(() => {
      timers.delete(delay);
      sync();
    }, delay);
    timers.set(delay, timer);
  };
  const settle = () => {
    sync();
    try { win.requestAnimationFrame(sync); } catch {}
    // iOS sometimes fires blur/visualViewport resize before its final geometry is committed.
    // Re-sample across the short keyboard animation rather than preserving that intermediate height.
    later(60);
    later(180);
    later(420);
  };
  const listen = (target, type, handler = settle, options = {}) => {
    target?.addEventListener?.(type, handler, { ...options, signal });
  };

  listen(visualViewport, 'resize', settle, { passive: true });
  listen(visualViewport, 'scroll', settle, { passive: true });
  listen(input, 'focus', settle);
  listen(input, 'blur', settle);
  listen(win, 'resize', settle, { passive: true });
  listen(win, 'orientationchange', settle, { passive: true });
  listen(win, 'pageshow', settle, { passive: true });
  signal?.addEventListener?.('abort', () => {
    for (const timer of timers.values()) win.clearTimeout(timer);
    timers.clear();
    clearPinnedViewport();
  }, { once: true });

  settle();
  return { sync, settle };
}
