import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = await mkdtemp(join(tmpdir(), 'aios-label-policy-'));
process.env.AIOS_DATA = join(scratch, 'data');
process.env.AIOS_PROXY_KEY = 'private-label-fixture';
process.env.AIOS_NO_LISTEN = '1';
const requests = [];
let mode = 'success', time = Date.now();
const originalNow = Date.now;
Date.now = () => time;
const modelServer = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  requests.push(body);
  res.setHeader('content-type', 'application/json');
  if (mode === 'missing') { res.statusCode = 404; return res.end(JSON.stringify({ error: { message: 'The model `background/qwen` does not exist.' } })); }
  if (mode === 'yield') { res.statusCode = 429; return res.end(JSON.stringify({ error: { message: 'Background request yielded to interactive traffic' } })); }
  const summary = body.messages.at(-1).content.startsWith('REQUESTS:');
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(summary
    ? { headline: 'Fixture project update', goal: 'Verify optional background labeling' }
    : { label: 'Visible request label', result: 'Labels respect demand and limits', status: 'done', relation: 'new', feature: 'Graph', task: 'Label policy' }) } }],
    usage: { prompt_tokens: 20, completion_tokens: 10 } }));
});
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
process.env.AIOS_LABEL_PORT = String(modelServer.address().port);
const store = await import('../src/store.js');
const labels = await import('../src/session_labels.js');
const space = await import('../src/session_space.js');
const until = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('fixture did not settle');
};
try {
  assert.equal(labels.labelConfig().mode, 'on_demand', 'existing and new installs default to on demand');
  assert.equal(labels.backgroundLabelingEnabled(), false);
  labels.setLabelConfig({ model: 'spark:qwen-fixture', enabled: true, min_interval_ms: 1 });
  assert.equal(labels.labelConfig().min_interval_ms, 30000, 'global cadence cannot be configured back to a tight loop');
  assert.equal(labels.setLabelConfig({ mode: 'invalid' }).mode, 'on_demand');
  const nativeFile = join(scratch, 'fixture.jsonl');
  await writeFile(nativeFile, [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Verify optional graph labeling.' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"rg graph"}' } },
  ].map(row => JSON.stringify({ ...row, timestamp: new Date(time).toISOString() })).join('\n') + '\n');
  const makeGraph = async id => {
    store.createSession({ id, tool: 'codex', tmux: 'no-pane-fixture', status: 'waiting' });
    const session = store.getSession(id);
    const built = await space.buildSessionSpace(session, { file: nativeFile });
    assert.equal(built.space.systems.length, 1);
    return session;
  };
  const one = await makeGraph('s_label_one');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(requests.length, 0, 'deterministic graph rebuilding does not start inference');
  space.kickLabels(one);
  await until(() => labels.getLabels(one.id).size > 0);
  assert.equal(requests.length, 1, 'explicit visible-graph demand labels the current request once');
  assert.equal(requests[0].model, 'background/qwen-fixture', 'Spark labels always use the yielding lane');
  const two = await makeGraph('s_label_two');
  for (let i = 0; i < 20; i++) space.kickLabels(two);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests.length, 1, 'other views cannot queue behind the first model call');
  time += 30000;
  assert.equal(requests.length, 1, 'elapsed time alone does not trigger labeling without a viewer');
  space.kickLabels(two);
  await until(() => labels.getLabels(two.id).size > 0);
  assert.equal(requests.length, 2);
  const three = await makeGraph('s_label_three');
  time += 30000; mode = 'missing'; space.kickLabels(three);
  await until(() => labels.labelConfig().failures === 1);
  assert.equal(requests.length, 3);
  assert.equal(labels.labelConfig().next_attempt_at, time + 900000, 'HTTP status plus actual missing-model text trigger backoff');
  for (let i = 0; i < 20; i++) space.kickLabels(three);
  assert.equal(requests.length, 3, 'refreshes during failure backoff never retry');
  time += 900000; mode = 'yield'; space.kickLabels(three);
  await until(() => labels.labelConfig().failures === 2);
  assert.equal(requests.length, 4);
  assert.equal(labels.labelConfig().next_attempt_at, time + 240000);
  const cached = labels.getLabels(one.id).size;
  labels.setLabeling(false); time += 240000; space.kickLabels(three);
  assert.equal(requests.length, 4);
  assert.equal(labels.getLabels(one.id).size, cached, 'switching off preserves all previously generated labels');
  assert.equal(labels.labelConfig().model, 'spark:qwen-fixture');
  assert.equal(labels.labelConfig().calls, 2, 'only successful model responses enter the usage counter');
  console.log(JSON.stringify({ source: 'real private model HTTP handler', graphBuildCalls: 0, visibleDemandCalls: 1,
    multiViewQueue: 0, missingModelBackoffMs: 900000, interactiveYieldBackoffMs: 240000, labelsPreserved: true }));
} finally {
  Date.now = originalNow;
  await new Promise(resolve => modelServer.close(resolve));
  store.db.close();
  await rm(scratch, { recursive: true, force: true });
}
console.log('session_labeling.test ok');
