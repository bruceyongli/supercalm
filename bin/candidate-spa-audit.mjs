#!/usr/bin/env node
// Pre-promotion browser gate. Boots the exact checkout being released against an isolated SQLite data
// directory and port, then runs the same fixture-independent SPA audit used after production restart.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});

const port = await freePort();
const data = await mkdtemp(join(tmpdir(), 'aios-candidate-audit-'));
const server = spawn(process.execPath, ['src/server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    AIOS_DATA: data,
    AIOS_PORT: String(port),
    AIOS_HOST: '127.0.0.1',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
server.stderr.on('data', (chunk) => { stderr += chunk; });

try {
  const audit = spawn(process.execPath, ['bin/spa-audit.mjs', `http://127.0.0.1:${port}/aios/`], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  const code = await new Promise((resolve, reject) => {
    audit.on('error', reject);
    audit.on('exit', (value, signal) => resolve(value ?? (signal ? 1 : 0)));
  });
  if (code !== 0) throw new Error(`candidate SPA audit failed with exit ${code}${stderr ? `; server: ${stderr.slice(-800)}` : ''}`);
} finally {
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  if (server.exitCode == null) server.kill('SIGKILL');
  await rm(data, { recursive: true, force: true });
}

console.log('candidate SPA audit passed');
