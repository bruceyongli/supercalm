// FitAddon and our mobile padding/cell correction can disagree by a few columns. Running both on
// every observer/presence tick used to shrink then expand an already-correct grid (e.g. 51→48→51).
// xterm invalidates its active link on each resize, making clicks disappear after closing a preview.
export function fitTerminalGrid(term, fit, layoutMetrics) {
  const settled = layoutMetrics();
  if (settled.colsCapacity === term.cols && settled.rowsCapacity === term.rows
    && settled.screenRatio >= 0.96 && settled.screenRatio <= 1.04) return;

  const before = `${term.cols}x${term.rows}`;
  fit.fit();
  const metrics = layoutMetrics();
  const refreshIfChanged = () => {
    if (`${term.cols}x${term.rows}` !== before) term.refresh?.(0, Math.max(0, term.rows - 1));
  };
  if (metrics.screenRatio >= 0.96 && Math.abs(metrics.colsCapacity - term.cols) <= 2) {
    refreshIfChanged();
    return;
  }
  if (!metrics.cellWidth || !metrics.cellHeight || !Number.isFinite(metrics.cellWidth) || !Number.isFinite(metrics.cellHeight)) return;
  if (metrics.colsCapacity !== term.cols || metrics.rowsCapacity !== term.rows) {
    term.resize(metrics.colsCapacity, metrics.rowsCapacity);
  }
  refreshIfChanged();
}
