import { statfsSync } from 'node:fs';
import { DATA_DIR } from './config.js';

const GiB = 1024 ** 3;
export function diskCapacity(info, { reserveBytes = Number(process.env.AIOS_DISK_RESERVE_BYTES) || 5 * GiB,
  warningBytes = Number(process.env.AIOS_DISK_WARNING_BYTES) || 20 * GiB } = {}) {
  const total = Number(info.blocks) * Number(info.bsize);
  const available = Number(info.bavail) * Number(info.bsize);
  const free = Number(info.bfree) * Number(info.bsize);
  return { total_bytes: total, available_bytes: available, used_bytes: total - free,
    available_ratio: total ? available / total : 0, reserve_bytes: reserveBytes,
    level: available < reserveBytes ? 'critical' : available < warningBytes || available < total * 0.1 ? 'warning' : 'healthy' };
}

export function currentDiskCapacity(path = DATA_DIR) {
  try { return { ...diskCapacity(statfsSync(path)), path, checked_at: Date.now() }; }
  catch (error) { return { path, level: 'unknown', error: String(error.message || error), checked_at: Date.now() }; }
}

// Cheap local filesystem metadata, not a directory scan. Never kill existing sessions on pressure.
export function assertDiskHeadroom(path = DATA_DIR) {
  for (const target of new Set([DATA_DIR, path])) {
    const disk = currentDiskCapacity(target);
    if (disk.level !== 'critical') continue;
    const error = new Error(`Disk space is critically low (${(disk.available_bytes / GiB).toFixed(1)} GiB available). Open Health → Disk usage and clean selected stopped sessions before starting or resuming an agent.`);
    error.code = 'disk-space-critical';
    error.status = 507;
    throw error;
  }
}
