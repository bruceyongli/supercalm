import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

// Real controller -> worker HTTP -> private tmux -> native receipt. No live session, CLI, model,
// project or SSH connection is used. The controller deliberately has no usable local tmux/history.
const exec = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), 'aios-remote-input-'));
const socket = `aios-remote-input-${process.pid}`;
const realTmux = (await exec('which', ['tmux'])).stdout.trim();
const quote = text => `'${String(text).replace(/'/g, "'\\''")}'`;
const wrapper = join(scratch, 'tmux');
writeFileSync(wrapper, `#!/bin/sh\nTMUX='' exec ${quote(realTmux)} -L ${quote(socket)} "$@"\n`, { mode: 0o755 });
const root = join(scratch, 'worker'), control = join(scratch, 'controller');
mkdirSync(root); mkdirSync(control);
const token = 'd'.repeat(64);
writeFileSync(join(root, 'control-token'), token, { mode: 0o600 });
const freePort = async () => {
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
};
const workerPort = await freePort(), controllerPort = await freePort();
Object.assign(process.env, {
  AIOS_DATA: join(root, 'data'), AIOS_ENV_FILE: join(scratch, 'absent.env'),
  AIOS_TMUX: wrapper, AIOS_PORT: String(workerPort), AIOS_HOST: '127.0.0.1',
  AIOS_EXECUTION_NODE: 'input-worker', AIOS_EXECUTION_ROOT: root,
  AIOS_EXECUTION_NODES_FILE: join(root, 'no-nodes.json'), AIOS_WORKTREE_ROOT: join(root, 'worktrees'),
  AIOS_CODEX_SESSIONS_DIR: join(root, 'native'), AIOS_CODEX_HISTORY_FILE: join(root, 'history.jsonl'),
  AIOS_SUBMIT_DELAY: '30', AIOS_AUTO_PUBLISH: '0',
  AIOS_EXECUTION_CATALOG_URL: 'http://127.0.0.1:1/models', AIOS_EXECUTION_MODEL_URL: 'http://127.0.0.1:1/model',
});
delete process.env.AIOS_NO_LISTEN;
mkdirSync(process.env.AIOS_CODEX_SESSIONS_DIR);
writeFileSync(process.env.AIOS_CODEX_HISTORY_FILE, '');
let child, store, cleaned = false, logs = '';
function cleanup() {
  if (cleaned) return; cleaned = true;
  child?.kill('SIGTERM');
  spawnSync(realTmux, ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 3000 });
  try { store?.db.close(); } catch {}
  rmSync(scratch, { recursive: true, force: true });
}
process.once('exit', cleanup);
process.once('SIGTERM', () => { cleanup(); process.exit(143); });
process.once('SIGINT', () => { cleanup(); process.exit(130); });
try {
  await (await import('../src/server.js')).featureReady;
  store = await import('../src/store.js');
  const cases = [
    { id: 's_remote_update', uuid: '11111111-2222-4333-8444-555555555551' },
    { id: 's_remote_skip', uuid: '11111111-2222-4333-8444-555555555552' },
  ];
  for (const { id, uuid } of cases) {
    const fixture = fileURLToPath(new URL('./fixtures/submit_agent_tui.mjs', import.meta.url));
    const args = ['new-session', '-d', '-s', id, '-x', '100', '-y', '50', process.execPath,
      fixture, join(scratch, `${id}.ndjson`), 'codex-update', 'codex', process.env.AIOS_CODEX_HISTORY_FILE, uuid];
    await new Promise((resolve, reject) => {
      const tui = spawn(wrapper, args, { stdio: 'ignore' });
      tui.on('error', reject); tui.on('exit', code => code === 0 ? resolve() : reject(Error(`tmux ${code}`)));
    });
    for (let n = 0; ; n++) {
      if ((await exec(wrapper, ['capture-pane', '-p', '-t', id])).stdout.includes('esc skip')) break;
      assert.ok(n < 60, 'private update modal ready'); await new Promise(resolve => setTimeout(resolve, 50));
    }
    store.createSession({ id, tool: 'codex', tmux: id });
    store.updateSession(id, { codex_uuid: uuid, status: 'waiting', execution_node: 'input-worker' });
  }
  const nodesFile = join(control, 'nodes.json');
  writeFileSync(nodesFile, JSON.stringify({ version: 1, nodes: [{ id: 'input-worker', host: 'localhost',
    local: true, root, token, localPort: workerPort, remotePort: workerPort, callbackPort: controllerPort }] }));
  const bootstrap = `await (await import(${JSON.stringify(new URL('../src/server.js', import.meta.url).href)})).featureReady;
    const store = await import(${JSON.stringify(new URL('../src/store.js', import.meta.url).href)});
    for (const {id, uuid} of ${JSON.stringify(cases)}) {
      if (!store.getSession(id)) store.createSession({id, tool:'codex', tmux:'not-on-controller'});
      store.updateSession(id, {execution_node:'input-worker', codex_uuid:uuid, status:'waiting'});
    }`;
  child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { env: { ...process.env,
    AIOS_DATA: join(control, 'data'), AIOS_PORT: String(controllerPort), AIOS_EXECUTION_NODE: 'local',
    AIOS_EXECUTION_ROOT: control, AIOS_EXECUTION_NODES_FILE: nodesFile, AIOS_TMUX: '/usr/bin/false',
    AIOS_CODEX_HISTORY_FILE: join(control, 'nonexistent-history'), AIOS_CODEX_SESSIONS_DIR: join(control, 'native'),
    AIOS_WORKTREE_ROOT: join(control, 'worktrees'),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => { logs = (logs + b).slice(-12000); });
  child.stderr.on('data', b => { logs = (logs + b).slice(-12000); });
  const base = `http://127.0.0.1:${controllerPort}`;
  for (let n = 0; ; n++) {
    assert.equal(child.exitCode, null, logs);
    try { if ((await fetch(base + '/api/session/s_remote_update?surface=header')).ok) break; } catch {}
    assert.ok(n < 300, logs); await new Promise(resolve => setTimeout(resolve, 100));
  }
  const request = async (path, body) => {
    const response = await fetch(base + path, body === undefined ? {} : { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const sid = cases[0].id, url = `/api/session/${sid}`;
  const before = await request(url + '/story');
  assert.equal(before.status, 200);
  assert.match(before.body.pendingQuestion?.body || '', /^Codex update available/);
  assert.deepEqual(before.body.pendingQuestion.options.map(o => o.label).slice(1), ['Skip', 'Skip until next version']);
  const text = '学生反应数学今日任务做完后没有被记录';
  const body = { text, client_message_id: 'remote-update-send-once' };
  const replies = await Promise.all([request(url + '/input', body), request(url + '/input', body)]);
  assert.ok(replies.every(r => r.status === 200), JSON.stringify(replies));
  assert.equal(replies[0].body.message.id, replies[1].body.message.id);
  const receipt = await request(url + '/input-receipt/' + body.client_message_id);
  assert.equal(receipt.status, 200); assert.equal(receipt.body.accepted, true);
  assert.equal(receipt.body.message.id, replies[0].body.message.id, 'receipt stays in the owning worker namespace');
  assert.equal((await request(url + '/input', body)).body.duplicate, true);
  const trace = readFileSync(join(scratch, `${sid}.ndjson`), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(trace.filter(e => e.event === 'update-key').map(e => [e.stage, e.data]), [['prompt', '\x1b']],
    'one Escape, no Enter on Update now, no bytes while the resumed conversation loads');
  assert.deepEqual(trace.filter(e => e.event === 'paste').map(e => e.text), [text]);
  assert.deepEqual(trace.filter(e => e.event === 'accepted').map(e => e.text), [text]);
  const history = readFileSync(process.env.AIOS_CODEX_HISTORY_FILE, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(history.map(r => [r.session_id, r.text]), [[cases[0].uuid, text]]);
  const event = store.eventsFor(sid, 20).find(e => e.type === 'input-delivery');
  assert.equal(JSON.parse(event.payload).receipt, 'codex-native-history');
  assert.equal(store.eventsFor(sid, 20).filter(e => e.type === 'codex-update-skipped').length, 1);
  assert.equal((await request(url + '/story')).body.pendingQuestion, null);
  assert.equal((await request('/api/session/s_remote_skip/input', { text: 'Skip', client_message_id: 'remote-explicit-skip' })).status, 200);
  const skipTrace = readFileSync(join(scratch, 's_remote_skip.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(skipTrace.filter(e => e.event === 'update-key').map(e => e.data), ['\x1b']);
  assert.equal(skipTrace.filter(e => e.event === 'paste' || e.event === 'accepted').length, 0, 'Story choice operates the menu, not a model message');
  console.log(JSON.stringify({ handler: 'controller /input -> worker /input -> deliverReply -> private tmux -> native history',
    storyChoices: 3, optionalUpdateEscapes: 1, requestCount: 3, accepted: 1, nativeId: cases[0].uuid,
    receiptOnOwner: receipt.body.accepted, wrongDeviceTmuxCalls: 0, liveSessionsTouched: false }));
  console.log('remote_input_update: passed');
} catch (error) { console.error(logs); throw error; }
finally {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000); });
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  cleanup();
}
process.exit(0);
