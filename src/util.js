import { randomBytes } from 'node:crypto';

export const now = () => Date.now();

export function id(prefix = '') {
  return (prefix ? prefix + '_' : '') + randomBytes(5).toString('hex');
}

export function slug(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'x'
  );
}

// POSIX single-quote shell escaping for safe tmux send-keys command lines.
export function shquote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Strip ANSI escape sequences (for plain-text snapshots / question extraction).
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;?]*[ -/]*[@-~]|[\]P^_].*?(?:|\\)|[@-Z\\-_]/g;
export function stripAnsi(s) {
  return String(s).replace(ANSI, '');
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
