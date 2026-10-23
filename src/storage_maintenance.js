// Durable maintenance interlock, local even when project storage is disconnected. It is not
// an operator Stop: no lifecycle, activity, attention, supervisor grant or history is rewritten.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

export const storageMaintenanceFile = join(DATA_DIR, 'storage-maintenance.json');
export function readStorageMaintenance(file = storageMaintenanceFile) {
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (value.version !== 1 || value.kind !== 'live-storage-migration' || !Array.isArray(value.sessions)) {
    throw Error('Invalid storage maintenance journal; refusing lifecycle changes');
  }
  return value.phase === 'complete' ? null : value;
}
export function storageMaintenanceFor(id, file = storageMaintenanceFile) {
  return readStorageMaintenance(file)?.sessions.find(s => s.id === id && s.phase !== 'complete') || null;
}
export function assertStorageSessionAvailable(id, token = null) {
  const pending = storageMaintenanceFor(id);
  if (pending && (!token || token !== pending.token)) throw storageMaintenanceError();
}
export function assertStorageLaunchAvailable() {
  if (readStorageMaintenance()?.blockLaunches) throw storageMaintenanceError();
}
export function storageMaintenanceError() {
  return Object.assign(Error('Storage migration is briefly pausing this session. Your message is preserved; retry when migration finishes.'),
    { code: 'storage-maintenance', status: 503 });
}
