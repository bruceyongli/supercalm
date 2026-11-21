// Private loopback HTTP over an SSH connection. The connection is transport only:
// launchd + the worker's local tmux/database own execution, not an SSH process lifetime.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createServer } from 'node:net';
import { withFileLease } from './archive_lock.js';
import { DATA_DIR, PORT } from './config.js';
import { executionId, migrationError } from './execution_identity.js';

export const executionRegistryFile = process.env.AIOS_EXECUTION_NODES_FILE || join(DATA_DIR, 'execution-nodes.json');
const configFile = executionRegistryFile;
let configured = [];
const connections = new Map();
export function validateExecutionNode(node) {
  executionId(node?.id);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,199}$/.test(node.host || '')) throw Error('Use a configured SSH host alias');
  if (!isAbsolute(node.root || '') || /[\r\n\0]/.test(node.root) || node.root === '/') throw Error('An absolute worker directory is required');
  for (const key of ['localPort', 'remotePort', 'callbackPort']) {
    if (!Number.isInteger(node[key]) || node[key] < 1024 || node[key] > 65535) throw Error('Invalid worker port');
  }
  if (!/^[a-f0-9]{64}$/.test(node.token || '')) throw Error('Worker control credential is missing');
  if (node.local && (node.host !== 'localhost' || node.localPort !== node.remotePort)) throw Error('Local execution must use the private loopback port');
  return { ...node, label: String(node.label || node.id).slice(0, 80), enabled: node.enabled !== false };
}
export async function loadExecutionNodes() {
  try {
    const doc = JSON.parse(await readFile(configFile, 'utf8'));
    if (doc.version !== 1 || !Array.isArray(doc.nodes)) throw Error('Invalid execution device registry');
    const nodes = doc.nodes.map(validateExecutionNode);
    if (new Set(nodes.map(n => n.id)).size !== nodes.length || new Set(nodes.map(n => n.localPort)).size !== nodes.length) throw Error('Duplicate execution device or local port');
    configured = nodes;
  } catch (error) { if (error.code !== 'ENOENT') throw error; configured = []; }
  return configured;
}
const hostName = n => n.host.split('@').at(-1).toLowerCase().replace(/\.$/, '');
export function assertNewDevice(nodes, node) {
  if (nodes.some(n => n.id === node.id || hostName(n) === hostName(node))) {
    throw migrationError('This device ID or SSH host is already registered. Existing devices were not changed.', 'execution-device-exists');
  }
}
async function availableForwardPort(nodes) {
  for (let port = 18893; port < 19093; port++) {
    if (nodes.some(n => n.localPort === port)) continue;
    const available = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', e => e.code === 'EADDRINUSE' ? resolve(false) : reject(e));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw migrationError('No free execution-device tunnel port is available.');
}
export function saveExecutionNode(node, { addOnly = false } = {}) {
  return withFileLease(configFile + '.lock', () => migrationError('Device registration is busy. Please retry.'), async () => {
    const nodes = await loadExecutionNodes();
    if (addOnly) {
      assertNewDevice(nodes, node);
      node = { ...node, localPort: await availableForwardPort(nodes), default: false };
    }
    return writeExecutionNode(node);
  });
}
async function writeExecutionNode(node) {
  const checked = validateExecutionNode(node);
  const nodes = [...configured.filter(n => n.id !== checked.id), checked];
  if (new Set(nodes.map(n => n.localPort)).size !== nodes.length) throw Error('Worker port is already registered');
  await mkdir(join(configFile, '..'), { recursive: true, mode: 0o700 });
  const tmp = configFile + '.tmp-' + randomUUID();
  await writeFile(tmp, JSON.stringify({ version: 1, nodes }, null, 2) + '\n', { flag:'wx', mode: 0o600 });
  await rename(tmp, configFile);
  configured = nodes;
  return checked;
}
export function executionNodes() { return configured.filter(n => n.enabled); }
export function defaultExecutionNode() { return executionNodes().find(n => n.default); }
export function executionNode(id) {
  const node = executionNodes().find(n => n.id === id);
  if (!node) throw migrationError('Execution device is not configured', 'execution-device-missing', 503);
  return node;
}
export function sshArguments(node) {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes', '-o', 'StrictHostKeyChecking=yes',
    '-N', '-T', '-L', `127.0.0.1:${node.localPort}:127.0.0.1:${node.remotePort}`,
    '-R', `127.0.0.1:${node.callbackPort}:127.0.0.1:${PORT}`, node.host];
}
export function connectExecutionNode(node) {
  if (node.local) return;
  const previous = connections.get(node.id);
  if (previous?.child || Date.now() < (previous?.retryAt || 0)) return;
  const child = spawn('/usr/bin/ssh', sshArguments(node), { stdio: 'ignore' });
  const current = { child, retryAt: 0 };
  connections.set(node.id, current);
  const close = () => { if (current.child !== child) return; current.child = null; current.retryAt = Date.now() + 10_000; };
  child.on('error', close);
  child.on('exit', close);
}
export function closeExecutionConnections() {
  for (const entry of connections.values()) entry.child?.kill('SIGTERM');
  connections.clear();
}
process.once('exit', closeExecutionConnections);

export async function nodeRequest(node, path, { method = 'GET', body, timeout = 15000 } = {}) {
  const response = await fetch(`http://127.0.0.1:${node.localPort}${path}`, {
    method, headers: { 'x-aios-node-token': node.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout),
  }).catch(() => { throw migrationError(`${node.label} is unreachable. Its sessions have not been restarted or moved.`, 'execution-device-offline', 503); });
  const data = await response.json();
  if (!response.ok) throw migrationError(data.error || 'Execution device request failed', data.code || 'execution-device-error', response.status);
  return data;
}

// Preserve streaming, Range, receipts, upload bytes and backpressure. A broken browser
// socket aborts its HTTP request, never the CLI. Mutating requests are never retried here.
export function proxyNodeRequest(node, req, res, path) {
  return new Promise(resolve => {
    const headers = { ...req.headers, host: `127.0.0.1:${node.remotePort}`, 'x-aios-node-token': node.token };
    delete headers.connection;
    delete headers['proxy-authorization'];
    const upstream = http.request({ hostname: '127.0.0.1', port: node.localPort, method: req.method, path, headers }, incoming => {
      res.writeHead(incoming.statusCode, incoming.headers);
      incoming.on('error', () => res.destroy());
      incoming.pipe(res);
      incoming.once('end', resolve);
    });
    const expire = () => upstream.destroy(new Error('Worker response deadline exceeded'));
    const uploading = req.method === 'POST' && /^\/api\/session\/[^/]+\/upload(?:\?|$)/.test(path);
    // Budget a file transfer by inactivity until the body is sent, then apply the
    // normal response-header deadline. All other requests retain their original deadline.
    let timeout;
    if (uploading) {
      upstream.setTimeout(30000, expire);
      upstream.once('finish', () => {
        if (!upstream.destroyed && !res.headersSent) timeout = setTimeout(expire, 15000);
      });
    } else timeout = setTimeout(expire, 15000);
    upstream.once('response', () => {
      clearTimeout(timeout);
      if (uploading) upstream.setTimeout(0);
    });
    upstream.on('error', () => {
      clearTimeout(timeout);
      if (!res.headersSent) {
        res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: `${node.label} is unavailable. No message was retried.`, code: 'execution-device-offline' }));
      } else res.destroy();
      resolve();
    });
    req.on('error', () => upstream.destroy());
    res.once('close', () => { clearTimeout(timeout); upstream.destroy(); resolve(); });
    req.pipe(upstream);
  });
}
