#!/usr/bin/env node
// Register an existing SSH device, or publish the exact committed runtime to it.
// No secrets on argv; no remote filesystem in the execution path.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadExecutionNodes, saveExecutionNode, executionNodes, executionNode, assertNewDevice } from '../src/execution_transport.js';
import { shquote as quote } from '../src/util.js';
import { checkPairingTarget, preparePairing } from '../src/execution_pairing.js';
import { inspectPairPlatform, pairError, pairingErrors, setupSshOptions, sshFailure } from '../src/execution_pair_checks.js';
import { COMMIT_SHA, PORT, VERSION, ROOT } from '../src/config.js';

const exec = promisify(execFile), root = dirname(dirname(fileURLToPath(import.meta.url)));
const ssh = (node, command, options = {}) => node.local ? spawn('/bin/sh', ['-c', command], options)
  : spawn('/usr/bin/ssh', [...setupSshOptions, node.host, command], options);
function completed(child) {
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error(`Device command exited ${code}`))); });
}
async function deploy(node, expectedSha) {
  const sha = (await exec('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  if (expectedSha && sha !== expectedSha) throw Error('Release changed during setup. Repeat the pairing command.');
  const dirty = (await exec('/usr/bin/git', ['-C', root, 'status', '--porcelain'])).stdout;
  if (dirty.trim()) throw Error('Commit the runtime before publishing an execution device');
  const runtime = JSON.parse(node.local ? await import('node:fs/promises').then(fs=>fs.readFile(join(node.root,'runtime.json'),'utf8'))
    : (await exec('/usr/bin/ssh', [...setupSshOptions, node.host,
      `/bin/cat ${quote(join(node.root, 'runtime.json'))}`], { timeout: 15000 })).stdout);
  if (!runtime.node?.startsWith(node.root + '/runtime/') || !runtime.path) throw Error('Run execution-bootstrap.mjs on this device first');
  const bundle = join(node.root, 'releases', `${sha}-${randomBytes(4).toString('hex')}.bundle`);
  const receiver = `const fs=require('node:fs'); const {pipeline}=require('node:stream/promises'); fs.mkdirSync(${JSON.stringify(dirname(bundle))},{recursive:true,mode:448}); pipeline(process.stdin,fs.createWriteStream(${JSON.stringify(bundle)},{flags:'wx',mode:384})).catch(()=>process.exit(1));`;
  const receive = ssh(node, `${quote(runtime.node)} -e ${quote(receiver)}`, { stdio: ['pipe','inherit','inherit'] });
  const bundleProcess = spawn('/usr/bin/git', ['-C', root, 'bundle', 'create', '-', 'HEAD'], { stdio: ['ignore','pipe','inherit'] });
  await Promise.all([pipeline(bundleProcess.stdout, receive.stdin), completed(bundleProcess), completed(receive)]);
  // The first clone is git-only; all subsequent configuration is performed by the
  // versioned worker installer from this exact candidate, with credentials on stdin.
  const bootstrap = `const fs=require('node:fs'),cp=require('node:child_process'); const app=${JSON.stringify(join(node.root,'app'))},bundle=${JSON.stringify(bundle)},sha=${JSON.stringify(sha)}; const git=args=>cp.execFileSync('/usr/bin/git',args,{stdio:['ignore','pipe','pipe']}); if(!fs.existsSync(app)){git(['clone',bundle,app]);} else {if(git(['-C',app,'status','--porcelain']).toString().trim())throw Error('Worker app has local changes');git(['-C',app,'fetch',bundle,'HEAD']);} git(['-C',app,'checkout','--detach',sha]);`;
  await completed(ssh(node, `${quote(runtime.node)} -e ${quote(bootstrap)}`, { stdio: 'inherit' }));
  const install = ssh(node, `${quote(runtime.node)} ${quote(join(node.root,'app/bin/execution-worker-service.mjs'))}`, { stdio: ['pipe','inherit','inherit'] });
  install.stdin.end(JSON.stringify({ ...node, runtime, sha, bundle }));
  await completed(install);
  console.log(`Execution device ${node.label}: ${sha}`);
}

// The controller and manual fallback use this same fixed installer. The proof
// is either consumed privately by the controller or shown to the local operator.
async function pair(id, host) {
  checkPairingTarget(id,host);
  assertNewDevice(await loadExecutionNodes(),{id,host});
  const live = await fetch('http://127.0.0.1:' + PORT + '/api/version', {signal:AbortSignal.timeout(5000)}).then(r => r.json());
  const tag = (await exec('/usr/bin/git', ['-C', ROOT, 'rev-parse', 'refs/tags/v' + VERSION + '^{commit}'])).stdout.trim();
  if (live.commit !== COMMIT_SHA || live.version !== VERSION || tag !== COMMIT_SHA) throw pairError('setup-release');
  const run = async (input, timeout, command = '/opt/homebrew/bin/node --input-type=module') => {
    const p = exec('/usr/bin/ssh', [...setupSshOptions,host,
      command], {timeout, maxBuffer:1024*1024});
    p.child.stdin.on('error', () => {}); p.child.stdin.end(input);
    try { return (await p).stdout; }
    catch (error) { throw sshFailure(error); }
  };
  console.log('Checking the target over SSH…');
  await inspectPairPlatform(run); // before creating a pairing record, reserving a worker or downloading anything
  const code = await preparePairing({id, host, commit: COMMIT_SHA}, async node => {
    const preflight = await readFile(join(ROOT, 'bin/execution-pair-target.mjs'), 'utf8');
    const reserve = preflight + '\nlet credential=""; for await(const c of process.stdin) credential+=c; console.log(JSON.stringify(await reserveWorker(credential)));';
    const {root} = JSON.parse(await run(node.token, 30000, '/opt/homebrew/bin/node --input-type=module -e ' + quote(reserve)));
    if (typeof root !== 'string' || !root.startsWith('/') || !root.endsWith('/.local/share/supercalm-executor')) throw Error('Unexpected worker directory');
    console.log('Installing the private runtime, then verifying the worker…');
    await run(await readFile(join(ROOT, 'bin/execution-bootstrap.mjs'), 'utf8'), 15*60_000);
    await deploy({...node, root}, COMMIT_SHA);
    return root;
  });
  console.log('In Settings → Execution devices → Add device, enter this code within 15 minutes:\n' + code);
}

await loadExecutionNodes();
const [action, id, host, path, ...ports] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
if (action === 'register') {
  let old; try { old = executionNode(id); } catch {}
  const node = await saveExecutionNode({ id, label: id, host, root: path,
    localPort: Number(ports[0] || 18893), remotePort: Number(ports[1] || 8794), callbackPort: Number(ports[2] || 18793),
    token: old?.token || randomBytes(32).toString('hex'), local: host === 'localhost', default: process.argv.includes('--default') || !!old?.default });
  console.log(`Registered ${node.id}. The next bin/deploy publishes its local runtime.`);
} else if (action === 'pair') {
  try { await pair(id, host); } catch (error) {
    const code=Object.hasOwn(pairingErrors,error.code) ? error.code : 'setup-failed';
    console.error('AIOS_PAIR_ERROR ' + code);
    console.error(pairingErrors[code]); process.exitCode = 1;
  }
} else if (action === 'deploy-all') {
  for (const node of executionNodes()) await deploy(node);
} else if (action === 'deploy') await deploy(executionNode(id));
else throw Error('Usage: execution-node.mjs register ID SSH_HOST ABSOLUTE_ROOT [LOCAL_PORT WORKER_PORT CALLBACK_PORT] | deploy-all | deploy ID');
