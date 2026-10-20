#!/usr/bin/env node
import { runScratchJob } from '../src/scratch_jobs.js';
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
process.exitCode = await runScratchJob(process.env.AIOS_SESSION_ID, args[0], args.slice(1));
