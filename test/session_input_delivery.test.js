import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const exec = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), 'aios-input-delivery-'));
const socket = `aios-input-${process.pid}`;
const wrapper = join(scratch, 'tmux.mjs');
const realTmux = (await exec('which', ['tmux'])).stdout.trim();
writeFileSync(wrapper, `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nconst r=spawnSync(${JSON.stringify(realTmux)}, ['-L',${JSON.stringify(socket)},...process.argv.slice(2)], {stdio:'inherit',env:{...process.env,TMUX:''}});process.exit(r.status ?? 1);\n`, { mode: 0o755 });
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
process.env.AIOS_DATA = join(scratch, 'data');
process.env.AIOS_TMUX = wrapper;
process.env.AIOS_HOST = '127.0.0.1';
process.env.AIOS_PORT = String(port);
process.env.AIOS_SUBMIT_DELAY = '30';
delete process.env.AIOS_NO_LISTEN;

let store;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  spawnSync(realTmux, ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 3000 });
  try { store?.db.close(); } catch {}
  rmSync(scratch, { recursive: true, force: true });
}
// The parallel runner terminates siblings when a different suite fails. Private daemons and fixtures
// must also disappear on that path, not just on an ordinary pass or assertion failure.
process.once('exit', cleanup);
process.once('SIGTERM', () => { cleanup(); process.exit(143); });
process.once('SIGINT', () => { cleanup(); process.exit(130); });
try {
  const { featureReady } = await import('../src/server.js');
  await featureReady;
  store = await import('../src/store.js');
  const { projectCheckpoint } = await import('../src/sessions.js');
  store.createProject({ id: 'p_checkpoint', name: 'isolated checkpoint fixture', path: scratch });
  let time = 0;
  const budgets = [];
  const runGit = async (root, args, options) => {
    budgets.push(options.timeout);
    if (args.includes('--is-inside-work-tree')) { time += 400; return { text: 'true', error: '' }; }
    return { text: '', error: '' };
  };
  await projectCheckpoint({ project_id: 'p_checkpoint' }, { runGit, clock: () => time });
  assert.deepEqual(budgets, [1000, 600, 600, 600], 'git metadata shares one short send-path budget');
  time = 0;
  assert.equal(await projectCheckpoint({ project_id: 'p_checkpoint' }, {
    clock: () => time, runGit: async () => { time = 1200; return { text: 'true', error: '' }; },
  }), null, 'expired optional bookkeeping is skipped before the prompt is sent');
  const fixture = fileURLToPath(new URL('./fixtures/submit_agent_tui.mjs', import.meta.url));
  async function start(name, mode, family) {
    const trace = join(scratch, `${name}.ndjson`);
    // Ignore stdio so starting this private daemon cannot keep an execFile pipe open forever.
    await new Promise((resolve, reject) => {
      const child = spawn(wrapper, ['new-session', '-d', '-s', name, '-x', '100', '-y', '30',
        process.execPath, fixture, trace, mode, family], { stdio: 'ignore' });
      child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`tmux exit ${code}`)));
    });
    for (let i = 0; i < 40; i++) {
      const screen = (await exec(wrapper, ['capture-pane', '-p', '-t', name])).stdout;
      if (/GPT-6-Astra|bypass permissions/.test(screen)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
      if (i === 39) throw new Error('fixture never became ready');
    }
    store.createSession({ id: name, tool: family, tmux: name });
    store.updateSession(name, { status: 'waiting' });
    return () => readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  }
  async function send(id, text) {
    const response = await fetch(`http://127.0.0.1:${port}/api/session/${id}/input`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    return { status: response.status, body: await response.json() };
  }
  for (const family of ['codex', 'claude']) {
    const sid = `s_${family}_delivery`;
    const trace = await start(sid, 'ignore-first', family);
    const message = `Deliver once to ${family}, even if the first Enter is ignored.`;
    const response = await send(sid, message);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const records = trace();
    assert.equal(records.filter(r => r.event === 'enter').length, 2);
    assert.deepEqual(records.filter(r => r.event === 'accepted').map(r => r.text), [message]);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages WHERE session_id=? AND direction='in'").get(sid).n, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE session_id=? AND type='composer-draft-archived'").get(sid).n, 0,
      'idle placeholders never trigger draft replacement or extra HTTP requests');
    const receipt = JSON.parse(store.db.prepare("SELECT payload FROM events WHERE session_id=? AND type='input-delivery' ORDER BY id DESC LIMIT 1").get(sid).payload);
    assert.equal(receipt.verified, true);
    assert.equal(receipt.attempts, 2);
    console.log(JSON.stringify({ family, handler: 'POST /api/session/:id/input', http: response.status, enters: 2, accepted: 1, persisted: 1 }));
  }
  const partialId = 's_partial_delivery';
  const partialTrace = await start(partialId, 'partial-paste', 'codex');
  const multiline = 'where is the map html for each codebase, I want to inspect visually,\n\nDo you think better model will result a better reconstruction? Should we try gpt6-sol and deepseek-flash-next in parallel to do a side by side comparison of the 4 models?';
  const partialResponse = await send(partialId, multiline);
  assert.equal(partialResponse.status, 200, JSON.stringify(partialResponse.body));
  assert.equal(partialTrace().filter(r => r.event === 'premature').length, 0, 'never submit a partial paste');
  assert.deepEqual(partialTrace().filter(r => r.event === 'accepted').map(r => r.text), [multiline]);
  console.log(JSON.stringify({ handler: 'POST /api/session/:id/input', scenario: 'slow multiline paste', http: 200, enters: 1, accepted: 1 }));
  const blocked = 's_blocked_delivery';
  const trace = await start(blocked, 'ignore-all', 'codex');
  const response = await send(blocked, 'This must not be marked as sent.');
  assert.equal(response.status, 409);
  assert.equal(response.body.reason, 'submit-unconfirmed');
  assert.equal(trace().filter(r => r.event === 'enter').length, 3);
  assert.equal(trace().filter(r => r.event === 'accepted').length, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages WHERE session_id=? AND direction='in'").get(blocked).n, 0);
  console.log(JSON.stringify({ handler: 'POST /api/session/:id/input', http: 409, reason: response.body.reason, enters: 3, accepted: 0, persisted: 0 }));
  console.log('session_input_delivery: passed (private tmux, no live sessions or projects modified)');
} finally {
  cleanup();
}
process.exit(0);
