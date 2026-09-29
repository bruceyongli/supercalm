// Native full-screen agent transcripts do not have a browser scrollback buffer.
// Codex accepts PageUp/PageDown even when it has not enabled mouse reporting.
// Never substitute arrows: those edit the composer or change a menu selection.
export function terminalScrollMode(term, tool) {
  const tracking = term.modes?.mouseTrackingMode;
  if (tracking ? tracking !== 'none' : term._core?.coreMouseService?.areMouseEventsActive) return 'mouse';
  if (tool === 'codex' && term.buffer?.active?.type === 'alternate') return 'pages';
  return 'local';
}

export function installTerminalScrolling({ element, term, getTool, send, cellAt, onLocalScroll, signal }) {
  let pageDelta = 0, pageTimer = null, touch = null, touchScrolled = false;
  const mode = () => terminalScrollMode(term, getTool());
  const cancelPages = () => { clearTimeout(pageTimer); pageTimer = null; pageDelta = 0; };
  signal?.addEventListener('abort', cancelPages, { once: true });

  function scroll(delta, point, deltaMode = 0) {
    const kind = mode();
    if (kind === 'local' || !delta) return false;
    const pixels = delta * (deltaMode === 1 ? 20 : deltaMode === 2 ? term.rows * 14 : 1);
    if (kind === 'mouse') {
      cancelPages();
      const { col, row } = cellAt(point);
      const count = Math.min(8, Math.max(1, Math.round(Math.abs(pixels) / 24)));
      send(`\x1b[<${delta < 0 ? 64 : 65};${col};${row}M`.repeat(count));
      return true;
    }
    if (Math.sign(pageDelta) !== Math.sign(pixels)) pageDelta = 0;
    // Coalesce high-resolution trackpad/touch events; bound each batch so inertia
    // cannot queue hundreds of pages or flood the terminal input endpoint.
    pageDelta = Math.max(-240, Math.min(240, pageDelta + pixels));
    if (!pageTimer) pageTimer = setTimeout(() => {
      pageTimer = null;
      if (signal?.aborted || mode() !== 'pages') { pageDelta = 0; return; }
      const count = Math.floor(Math.abs(pageDelta) / 80);
      const direction = Math.sign(pageDelta);
      pageDelta %= 80;
      if (count) send((direction < 0 ? '\x1b[5~' : '\x1b[6~').repeat(count));
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
    cancelPages();
    touchScrolled = false;
    const point = event.touches.length === 1 ? event.touches[0] : null;
    touch = point ? { x: point.clientX, y: point.clientY } : null;
    onLocalScroll();
  }, { capture: true, passive: true, signal });
  element.addEventListener('touchmove', (event) => {
    if (!touch || event.touches.length !== 1) { touch = null; touchScrolled = true; cancelPages(); return; }
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
  element.addEventListener('touchcancel', () => { touch = null; touchScrolled = true; cancelPages(); }, { passive: true, signal });
  return { isTouchScrolling: () => touchScrolled };
}
