#!/usr/bin/env node
import { fetchReleaseContext, runProjectRelease } from '../src/project_release_guard.js';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, delimiter } from 'node:path';

async function nativePackageTool(tool) {
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(tool)) throw Error('Use a reviewed package release command');
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    try {
      const dir = await realpath(directory);
      if (dir.endsWith('/scripts/guard-bin')) continue;
      const executable = join(dir, tool);
      await access(executable, constants.X_OK);
      if ((await realpath(executable)).includes('/scripts/guard-bin/')) continue;
      return executable;
    } catch { /* try the next installed package manager */ }
  }
  throw Error('Cannot find the native package manager: ' + tool);
}

try {
  const [tool, entry, ...rest] = process.argv.slice(2);
  // Stable entry: node RUNNER npm run deploy:frontend. A login shell need not retain our PATH
  // wrapper. Keep the existing wrapper's explicit executable argument supported too.
  const direct = entry === 'run' || entry === 'run-script';
  const executable = direct ? await nativePackageTool(tool) : entry;
  const args = direct ? [entry, ...rest] : rest;
  const refreshContext = () => fetchReleaseContext(process.env.AIOS_SESSION_ID, process.env.AIOS_URL);
  const context = await refreshContext();
  const env = { ...process.env, PATH: (process.env.PATH || '').split(delimiter).filter(dir => !dir.replace(/\/$/, '').endsWith('/scripts/guard-bin')).join(delimiter) };
  process.exitCode = await runProjectRelease(context, { tool, executable, args, cwd: process.cwd(), env, refreshContext });
} catch (error) {
  console.error('Supercalm release guard: ' + error.message);
  process.exitCode = 126;
}
