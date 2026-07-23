import { parentPort, workerData } from 'node:worker_threads';
import { usageDashboardReport } from './usage_store.js';

try {
  parentPort.postMessage({ ok: true, report: usageDashboardReport(workerData?.filters || {}) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error?.message || error) });
}
