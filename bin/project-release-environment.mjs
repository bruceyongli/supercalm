#!/usr/bin/env node
// Install only explicitly selected project values delivered on stdin over the approved transport.
import { homedir } from 'node:os';
import { installProjectEnvironment } from '../src/project_release_environment.js';
try {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 1024 * 1024) throw Error('Project environment request too large'); }
  let request;
  try { request = JSON.parse(input); } catch { throw Error('Invalid project environment request'); }
  console.log(JSON.stringify(await installProjectEnvironment({ ...request, home: homedir() })));
} catch (error) { console.error(error.message); process.exitCode = 1; }
