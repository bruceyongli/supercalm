#!/usr/bin/env node
import { fetchReleaseContext, runProjectRelease } from '../src/project_release_guard.js';

try {
  const [tool, executable, ...args] = process.argv.slice(2);
  const refreshContext = () => fetchReleaseContext(process.env.AIOS_SESSION_ID, process.env.AIOS_URL);
  const context = await refreshContext();
  process.exitCode = await runProjectRelease(context, { tool, executable, args, cwd: process.cwd(), refreshContext });
} catch (error) {
  console.error('Supercalm release guard: ' + error.message);
  process.exitCode = 126;
}
