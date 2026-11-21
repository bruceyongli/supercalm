import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const loopback = h => h === 'localhost' || h === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(h);
export function configuredSessionBase(value) {
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol) || loopback(u.hostname) || u.username || u.password || u.search || u.hash) return null;
    return u.origin + (u.pathname === '/' ? '/aios/' : u.pathname.replace(/\/?$/, '/'));
  } catch { return null; }
}
export function tailnetSessionBase(config, port) {
  for (const [host, web] of Object.entries(config?.Web || {})) {
    if (!/^[a-z0-9.-]+\.ts\.net:443$/i.test(host)) continue;
    const proxy = (web.Handlers?.['/aios'] || web.Handlers?.['/aios/'])?.Proxy;
    try {
      const u = new URL(proxy);
      if (/^https?:$/.test(u.protocol) && loopback(u.hostname) && +u.port === +port && u.pathname === '/' && !u.username && !u.password && !u.search && !u.hash)
        return new URL('/aios/', 'https://' + host).href;
    } catch {}
  }
  return null;
}

// Only requested when a user opens the share menu on loopback. Read the existing Serve mapping;
// never publish a route, guess a worker hostname, or let an isolated dev server link to production.
let flight, until = 0;
export function sessionLinkBase(port) {
  const configured = configuredSessionBase(process.env.AIOS_SELF_URL);
  if (configured) return Promise.resolve(configured);
  if (!flight || Date.now() >= until) {
    until = Date.now() + 60_000;
    const bin = ['/opt/homebrew/bin/tailscale','/usr/local/bin/tailscale'].find(existsSync) || 'tailscale';
    flight = promisify(execFile)(bin,['serve','status','--json'],{timeout:1500,maxBuffer:512*1024})
      .then(({stdout}) => tailnetSessionBase(JSON.parse(stdout),port)).catch(() => null);
  }
  return flight;
}
