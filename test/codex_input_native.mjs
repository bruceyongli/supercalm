// Opt-in real installed Codex TUI probe. Private tmux/socket/home, loopback-only mock provider;
// never opens a production conversation or calls a model. Run directly, not in the portable suite.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { submitAgentComposer } from '../src/agent_submit.js';
const exec = promisify(execFile);
const scratch = await mkdtemp(join(tmpdir(), 'aios-codex-input-'));
const socket = `aios-codex-input-${process.pid}`;
const captures = [];
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.method === 'POST') {
    let body; try { body = JSON.parse(raw); } catch {}
    captures.push({ path: req.url, input: body?.input });
    const response = { id: 'resp_fixture', object: 'response', status: 'completed',
      output: [{ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Fixture received.', annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: response.output[0] },
      { type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: 'Fixture received.' },
      { type: 'response.output_item.done', output_index: 0, item: response.output[0] },
      { type: 'response.completed', response }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const tmux = (...args) => exec('tmux', ['-L', socket, ...args], { timeout: 10000 });
const text = process.env.AIOS_PROBE_TEXT || ('请把今天学习整理成同一页面，按照学科排序，保留原来的全部功能。'.repeat(Number(process.env.AIOS_PROBE_REPEAT || 90))
  + '\n\nAttached files available locally to this coding CLI:\n'
  + [1, 2, 3].map(n => `${n}. Screenshot ${n}.png (PNG, image/png): /fixture/Screenshot ${n}.png`).join('\n')
  + '\n\nOpen these paths directly when you need the uploaded content.');
try {
  await mkdir(join(scratch, 'home')); await mkdir(join(scratch, 'project'));
  await exec('git', ['init', '-q', join(scratch, 'project')]);
  const codex = (await exec('which', ['codex'])).stdout.trim();
  await tmux('new-session', '-d', '-s', 'probe', '-x', process.env.AIOS_PROBE_COLS || '92', '-y', process.env.AIOS_PROBE_ROWS || '30',
    '-e', `CODEX_HOME=${join(scratch, 'home')}`, '-e', 'TERM=xterm-256color',
    codex, '--no-daemon', '--no-alt-screen', '-C', join(scratch, 'project'), '-s', 'read-only', '-a', 'never',
    '-m', 'gpt-6.1-sol', '-c', 'model_provider="fixture"', '-c', 'model_providers.fixture.name="Fixture"',
    '-c', 'features.plugins=false',
    '-c', `model_providers.fixture.base_url="http://127.0.0.1:${server.address().port}/v1"`,
    '-c', 'model_providers.fixture.wire_api="responses"', '-c', 'model_providers.fixture.requires_openai_auth=false',
    '-c', `projects.${JSON.stringify(await realpath(join(scratch, 'project')))}.trust_level="trusted"`,
    '-c', 'tui.status_line=["model-with-reasoning","current-dir"]');
  const readScreen = async () => (await tmux('capture-pane', '-p', '-t', 'probe')).stdout;
  let before;
  for (let i = 0; i < 900; i++) {
    before = await readScreen();
    if (/Trust this folder\?/.test(before) && /1\. Trust and continue/.test(before)) {
      // This private CLI owns only the freshly initialized empty fixture repo/home above.
      await tmux('send-keys', '-t', 'probe', 'Enter');
      await sleep(200);
      continue;
    }
    // The early placeholder precedes folder trust and engine startup. It is NOT readiness.
    if (/› Ask Codex to do anything/.test(before) && /gpt-/i.test(before)) break;
    if (i === 899) throw new Error(`CLI not ready: ${before}`);
    await sleep(100);
  }
  const payload = process.env.AIOS_PROBE_LITERAL === '1' ? text : `\x1b[200~${text}\x1b[201~`;
  await tmux('send-keys', '-t', 'probe', '-l', '--', payload);
  await sleep(600);
  const pasted = await readScreen();
  const historyRows = async () => (await readFile(join(scratch, 'home/history.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const result = await submitAgentComposer({ pasteCompleted: true, readScreen,
    confirmSubmission: async () => (await historyRows()).some(r => r.text === text) ? { receipt: 'codex-native-history' } : null,
    pressEnter: () => tmux('send-keys', '-t', 'probe', 'Enter') });
  for (let i = 0; i < 100 && !captures.some(c => c.input); i++) await sleep(100);
  const requests = captures.filter(c => c.input?.some(x => x.role === 'user' && x.content?.some(p => p.text === text)));
  const history = (await readFile(join(scratch, 'home/history.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(result.accepted, true, JSON.stringify({ result, pasted, after: await readScreen(), history, captures }));
  assert.equal(requests.length, 1, JSON.stringify({ result, captures, after: await readScreen() }));
  assert.equal(history.filter(r => r.text === text).length, 1);
  console.log(JSON.stringify({ cli: (await exec(codex, ['--version'])).stdout.trim(),
    viewport: [process.env.AIOS_PROBE_COLS || 92, process.env.AIOS_PROBE_ROWS || 30],
    textLength: text.length, folded: pasted.includes('[Pasted Content'), result,
    exactFullRequests: requests.length, nativeHistoryReceipts: 1, externalModelCalls: 0, liveSessionsTouched: false }));
} finally {
  await tmux('kill-server').catch(() => {});
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(error => console.error('Fixture cleanup:', error.message));
}
