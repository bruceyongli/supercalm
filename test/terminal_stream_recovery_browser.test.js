import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { shquote } from '../src/util.js';

const exec = promisify(execFile), scratch = mkdtempSync(join(tmpdir(), 'aios-stream-recovery-'));
const socket = `aios-stream-${process.pid}`, wrapper = join(scratch, 'tmux.sh');
const realTmux = (await exec('which', ['tmux'])).stdout.trim();
writeFileSync(wrapper, `#!/bin/sh\nTMUX='' exec ${shquote(realTmux)} -L ${shquote(socket)} "$@"\n`, { mode: 0o700 });
const tmux = async (...args) => (await exec(wrapper, args, { timeout: 5000, encoding: 'utf8' })).stdout.trim();
const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port; await new Promise(r => probe.close(r));
process.env.AIOS_DATA = join(scratch, 'data'); process.env.AIOS_TMUX = wrapper;
process.env.AIOS_HOST = '127.0.0.1'; process.env.AIOS_PORT = String(port);
delete process.env.AIOS_NO_LISTEN;
let browser, store, cleaned = false;
function cleanup() {
  if (cleaned) return; cleaned = true;
  spawnSync(realTmux, ['-L', socket, 'kill-server'], { timeout: 3000, stdio: 'ignore' });
  try { store?.db.close(); } catch {}
  rmSync(scratch, { recursive: true, force: true });
}
process.once('exit', cleanup);
process.once('SIGTERM', () => { cleanup(); process.exit(143); });
process.once('SIGINT', () => { cleanup(); process.exit(130); });
try {
  const sid = 's_terminal_recovery', name = 'aios-stream-fixture';
  const fixture = fileURLToPath(new URL('./fixtures/terminal_stream_tui.mjs', import.meta.url));
  await new Promise((resolve, reject) => {
    const child = spawn(wrapper, ['new-session', '-d', '-s', name, '-x', '100', '-y', '30', process.execPath, fixture], { stdio: 'ignore' });
    child.once('error', reject); child.once('exit', c => c ? reject(Error(`tmux ${c}`)) : resolve());
  });
  store = await import('../src/store.js');
  store.createSession({ id: sid, tool: 'claude', tmux: name, task: 'Terminal stream fixture' });
  store.updateSession(sid, { status: 'working', desired_status: 'working', runtime_status: 'running' });
  const logFile = join(process.env.AIOS_DATA, 'logs', sid + '.log');
  mkdirSync(join(process.env.AIOS_DATA, 'logs'), { recursive: true });
  writeFileSync(logFile, 'PRESERVED_HISTORY\r\n');
  const pid = await tmux('display-message', '-p', '-t', name, '#{pane_pid}');
  assert.equal(await tmux('display-message', '-p', '-t', name, '#{pane_pipe}'), '0');
  const { featureReady } = await import('../src/server.js'); await featureReady;
  assert.equal(await tmux('display-message', '-p', '-t', name, '#{pane_pipe}'), '1', 'boot restores missing loggers before any viewer connects');
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 820, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 1000 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('https://fonts.**/*', route => route.abort());
    await page.addInitScript(() => {
      let Terminal;
      Object.defineProperty(window, 'Terminal', { configurable: true, get: () => Terminal,
        set: Original => { Terminal = class extends Original { constructor(...args) { super(...args); window.__capturedTerminal = this; } }; } });
      window.__streamConnections = 0;
      const ES = window.EventSource;
      window.EventSource = class extends ES { constructor(url, opts) { super(url, opts); if (String(url).includes('/stream')) this.addEventListener('open', () => window.__streamConnections++); } };
    });
    await page.goto(`http://127.0.0.1:${port}/aios/session?id=${sid}&desktop=1&noresize&noTerminalHistory`);
    await page.waitForFunction(() => document.querySelector('.workspace-tabs [data-mode="terminal"]') && window.__capturedTerminal);
    await page.locator('.workspace-tabs [data-mode="terminal"]').click();
    await page.waitForFunction(() => __capturedTerminal.buffer.active.getLine(__capturedTerminal.buffer.active.baseY)?.translateToString().includes('STREAM_FRAME_'));
    const frame = () => page.evaluate(() => Number(__capturedTerminal.buffer.active.getLine(__capturedTerminal.buffer.active.baseY).translateToString().match(/STREAM_FRAME_(\d+)/)?.[1]));
    const before = await frame();
    await page.waitForFunction(n => Number(__capturedTerminal.buffer.active.getLine(__capturedTerminal.buffer.active.baseY).translateToString().match(/STREAM_FRAME_(\d+)/)?.[1]) > n + 2, before);
    // Reproduce the real incident: stop only our fixture's logger, not its agent.
    await tmux('pipe-pane', '-t', name);
    assert.equal(await tmux('display-message', '-p', '-t', name, '#{pane_pipe}'), '0');
    await page.waitForTimeout(300);
    const frozen = await frame(), recoveredAt = Date.now();
    await page.waitForFunction(() => __streamConnections >= 2, null, { timeout: 14000 });
    await page.waitForFunction(n => Number(__capturedTerminal.buffer.active.getLine(__capturedTerminal.buffer.active.baseY).translateToString().match(/STREAM_FRAME_(\d+)/)?.[1]) > n + 3, frozen);
    const recoveryMs = Date.now() - recoveredAt;
    const current = await frame();
    await page.waitForFunction(n => Number(__capturedTerminal.buffer.active.getLine(__capturedTerminal.buffer.active.baseY).translateToString().match(/STREAM_FRAME_(\d+)/)?.[1]) > n + 2, current);
    assert.equal(await tmux('display-message', '-p', '-t', name, '#{pane_pid}'), pid, 'agent process survives logger recovery unchanged');
    assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation').length), 1, 'updates resume without refresh or Story switching');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, before, frozen, recovered: current, recoveryMs, realPTY: true, realSSE: true, renderedXterm: true, agentPidUnchanged: true }));
    await page.close();
  }
  assert.ok(readFileSync(logFile, 'utf8').startsWith('PRESERVED_HISTORY'), 'recovery appends; existing logs are never truncated');
  assert.ok(statSync(logFile).size > 100);
  assert.equal(store.db.prepare("SELECT count(*) n FROM messages WHERE session_id=? AND direction='in'").get(sid).n, 0, 'no coding-agent prompts were submitted');
} finally { await browser?.close(); cleanup(); }
console.log('terminal_stream_recovery: boot + connected-client recovery at desktop, tablet and phone widths passed');
process.exit(0);
