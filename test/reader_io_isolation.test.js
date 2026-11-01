import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, appendFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { readStoryPage } from '../src/story_reader.js';
import { readSpace } from '../src/session_space_reader.js';

// A FIFO blocks the same libuv filesystem pool as a slow mount, without stressing CPU, creating
// a remote fixture, or changing live sessions. Use one pool thread to make starvation deterministic.
if (process.env.AIOS_READER_IO_FIXTURE !== '1') {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, UV_THREADPOOL_SIZE: '1', AIOS_READER_IO_FIXTURE: '1' },
    stdio: 'inherit', timeout: 15000,
  });
  assert.equal(child.status, 0, child.error?.message || 'reader isolation subprocess');
} else {
  const root = mkdtempSync(join(tmpdir(), 'aios-reader-io-'));
  const file = join(root, 'native.jsonl'), fifo = join(root, 'blocked-io');
  const row = (role, text, n) => JSON.stringify({ timestamp: new Date(1700000000000 + n * 1000).toISOString(),
    type: 'response_item', payload: { type: 'message', role, phase: 'final_answer',
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } }) + '\n';
  let blocked, local, released = false;
  const release = () => { if (!released) { released = true; closeSync(openSync(fifo, 'w')); } };
  try {
    assert.equal(spawnSync('/usr/bin/mkfifo', [fifo]).status, 0);
    writeFileSync(file, row('user', 'Check exact session report', 1) + row('assistant', 'Original report', 2));
    await readStoryPage({ file });
    await readSpace({ file, session: { id: 's_fixture', tool: 'codex' } });
    appendFileSync(file, row('assistant', 'New report while shared filesystem IO is blocked', 3));
    blocked = readFile(fifo);
    await delay(80);
    let localDone = false;
    local = readFile(file).then(() => { localDone = true; });
    await delay(40);
    assert.equal(localDone, false, 'ordinary async filesystem reads really are queued behind the blocked pool');
    const began = performance.now();
    const first = readStoryPage({ file }), second = readStoryPage({ file });
    assert.equal(first, second, 'concurrent requests share exactly one native read');
    const deadline = setTimeout(release, 2500);
    try {
      const [story, graph] = await Promise.all([first, readSpace({ file, session: { id: 's_fixture', tool: 'codex' } })]);
      assert.ok(story.events.some(e => e.body === 'New report while shared filesystem IO is blocked'));
      assert.equal(story.meta.readMode, 'incremental');
      assert.ok(graph.bytesRead > 0);
      assert.equal(released, false, 'Story and graph must finish before the shared pool is unblocked');
      assert.equal(localDone, false, 'readers cannot depend on the saturated HTTP filesystem pool');
      console.log(JSON.stringify({ sharedFilesystemPool: 'blocked', story: 'fresh native report', graph: 'complete',
        nativeReadCoalesced: true, isolatedReadMs: Math.round(performance.now() - began) }));
    } finally { clearTimeout(deadline); release(); }
    await Promise.all([blocked, local]);
  } finally {
    if (blocked && !released) release();
    await Promise.allSettled([blocked, local]);
    rmSync(root, { recursive: true, force: true });
  }
}
