#!/usr/bin/env node
// Explicit operator configuration only. No key provisioning or silent migration of credentials.
import { homedir } from 'node:os';
import { configureExecutionConnection } from '../src/execution_connections.js';

let input = '';
for await (const chunk of process.stdin) { input += chunk; if (input.length > 8192) throw Error('Connection request too large'); }
const { root, ...spec } = JSON.parse(input);
console.log(JSON.stringify(await configureExecutionConnection({ root, home: homedir(), spec })));
