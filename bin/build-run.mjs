#!/usr/bin/env node
// Deliberately separate from the coding-agent launch and deployment pipeline.
import { runLocalBuildJob, sweepLocalBuildJobs } from '../src/local_build_jobs.js';
const args = process.argv.slice(2), options = { include: [], outputs: [] };
try {
  if (args.length === 1 && args[0] === '--sweep') {
    console.log(JSON.stringify(await sweepLocalBuildJobs()));
  } else {
    while (args[0] && args[0] !== '--') {
      const flag = args.shift(), value = args.shift();
      if (!value || !['--source', '--include', '--output'].includes(flag)) throw Error('Usage: build-run.mjs [--source DIR] [--include RELATIVE_PATH] [--output RELATIVE_PATH] -- COMMAND ARGS...');
      if (flag === '--source') options.source = value;
      else options[flag === '--include' ? 'include' : 'outputs'].push(value);
    }
    if (args.shift() !== '--' || !args.length) throw Error('A build command after -- is required');
    process.exitCode = await runLocalBuildJob(process.env.AIOS_SESSION_ID, args[0], args.slice(1), options);
  }
} catch (error) { console.error('[aios] ' + error.message); process.exitCode = 125; }
