// Native full-screen agent transcripts do not have a browser scrollback buffer.
// Codex accepts SGR wheel reports even when it has not enabled mouse reporting.
// Never substitute arrows: those edit the composer or change a menu selection.
export function terminalScrollMode(term, tool) {
  const tracking = term.modes?.mouseTrackingMode;
  if (tracking ? tracking !== 'none' : term._core?.coreMouseService?.areMouseEventsActive) return 'mouse';
  if (tool === 'codex' && term.buffer?.active?.type === 'alternate') return 'native-wheel';
  return 'local';
}

// Both supported full-screen CLIs expose Ctrl+End as jump-to-latest + resume-follow. Their
// history position is NOT xterm's viewportY: alternate buffers always report zero scrollback.
export function terminalHasNativeLatest(term, tool) {
  return (tool === 'codex' || tool === 'claude') && term.buffer?.active?.type === 'alternate';
}

export function terminalLatestVisible(term, tool) {
  // Keep the escape hatch available in an owned CLI screen, including when another browser/device
  // scrolled it. No reliable browser-side bottom coordinate exists for native history.
  if (terminalHasNativeLatest(term, tool)) return true;
  const buffer = term.buffer?.active;
  return Number(buffer?.baseY || 0) - Number(buffer?.viewportY || 0) > 2;
}

export function installTerminalScrolling({ element, term, getTool, send, cellAt, onLocalScroll, onNativeScroll = () => {}, signal }) {
  let wheelDelta = 0, wheelTimer = null, touch = null, touchScrolled = false;
  const mode = () => terminalScrollMode(term, getTool());
  const cancelWheel = () => { clearTimeout(wheelTimer); wheelTimer = null; wheelDelta = 0; };
  signal?.addEventListener('abort', cancelWheel, { once: true });

  function scroll(delta, point, deltaMode = 0) {
    const kind = mode();
    if (kind === 'local' || !delta) return false;
    const pixels = delta * (deltaMode === 1 ? 20 : deltaMode === 2 ? term.rows * 14 : 1);
    if (Math.sign(wheelDelta) !== Math.sign(pixels)) wheelDelta = 0;
    // A native wheel event advances a few rows, never an entire screen. Retain
    // fractional trackpad deltas rather than rounding every tiny event upward.
    const lineHeight = (element.querySelector('.xterm-screen')?.getBoundingClientRect().height || term.rows * 14) / term.rows;
    const step = Math.max(12, lineHeight * 3);
    wheelDelta = Math.max(-step * 8, Math.min(step * 8, wheelDelta + pixels));
    const { col, row } = cellAt(point);
    if (!wheelTimer) wheelTimer = setTimeout(() => {
      wheelTimer = null;
      if (signal?.aborted || mode() !== kind) { wheelDelta = 0; return; }
      const count = Math.floor(Math.abs(wheelDelta) / step);
      const direction = Math.sign(wheelDelta);
      wheelDelta %= step;
      if (count) {
        onNativeScroll();
        send(`\x1b[<${direction < 0 ? 64 : 65};${col};${row}M`.repeat(count));
      }
    }, 50);
    return true;
  }

  // Capture before xterm's handlers: only one owner may process a scroll gesture.
  element.addEventListener('wheel', (event) => {
    if (event.ctrlKey || event.metaKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    if (scroll(event.deltaY, event, event.deltaMode)) {
      event.preventDefault();
      event.stopPropagation();
    } else onLocalScroll();
  }, { capture: true, passive: false, signal });
  element.addEventListener('touchstart', (event) => {
    cancelWheel();
    touchScrolled = false;
    touch = null;
    if (event.target.closest?.('button')) return; // tapping Latest is navigation, not a reading gesture
    const point = event.touches.length === 1 ? event.touches[0] : null;
    touch = point ? { x: point.clientX, y: point.clientY } : null;
    onLocalScroll();
  }, { capture: true, passive: true, signal });
  element.addEventListener('touchmove', (event) => {
    if (!touch || event.touches.length !== 1) { touch = null; touchScrolled = true; cancelWheel(); return; }
    const point = event.touches[0];
    const delta = touch.y - point.clientY;
    if (Math.abs(delta) < 8 || Math.abs(point.clientX - touch.x) > Math.abs(delta)) return;
    touchScrolled = true;
    touch = { x: point.clientX, y: point.clientY };
    if (scroll(delta, point)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { capture: true, passive: false, signal });
  element.addEventListener('touchend', () => { touch = null; }, { passive: true, signal });
  element.addEventListener('touchcancel', () => { touch = null; touchScrolled = true; cancelWheel(); }, { passive: true, signal });
  return {
    isTouchScrolling: () => touchScrolled,
    jumpToLatest() {
      cancelWheel(); // a pending upward gesture must not undo the explicit jump
      if (signal?.aborted) return;
      if (terminalHasNativeLatest(term, getTool())) send('\x1b[1;5F');
      term.scrollToBottom();
    },
  };
}
