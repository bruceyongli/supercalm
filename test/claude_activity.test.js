import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeClaudeActivity, claudeActivityRecord, claudeAttentionKey } from '../src/claude_activity.js';
import { classify } from '../src/detect_classify.js';
import { rememberClaudeHook, clearClaudeLifecycle, claudeTerminalFrame } from '../src/claude_lifecycle.js';
import { splitSessionRecency } from '../web/session-recency.js';
import { isRecentVoiceSession } from '../web/voice-recency.js';

const native = '12345678-1234-1234-1234-123456789abc';
const at = Date.now(), old = at - 18 * 86400_000;
const session = { id: 's_activity', tool: 'claude', status: 'waiting', autonomy: 'ask', last_activity: old };
const row = (type, timestamp, extra = {}) => ({ type, timestamp: new Date(timestamp).toISOString(), sessionId: native, ...extra });
const assistant = (id, timestamp, text, reason = 'end_turn', extra = {}) => row('assistant', timestamp,
  { uuid: id, message: { id, content: [{ type: 'text', text }], stop_reason: reason }, ...extra });
const line = value => JSON.stringify(value) + '\n';
const pane = body => `${body}\n✻ Cogitated for 1m 39s · done 11:13 PM\n────────────────\n❯ commit this\n────────────────\n⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents\n`;
const oldReport = assistant('report-old', old, 'The docs endpoint is ready.');
const dir = await mkdtemp(join(tmpdir(), 'aios-claude-activity-'));
try {
  const file = join(dir, `${native}.jsonl`), entry = {};
  session.claude_transcript = file;
  await writeFile(file, line(oldReport));
  let result = await observeClaudeActivity(entry, file, at);
  assert.equal(result.initial, true);
  assert.equal(result.changed, false, 'hydration does not restart an old conversation');
  assert.equal(result.lastAt, old);
  for (const maintenance of ['Auto-updating…', 'Update available', 'Remote Control connected', '↻ Syncing status']) {
    await utimes(file, new Date(at), new Date(at));
    result = await observeClaudeActivity(entry, file, at);
    assert.equal(result.changed, false, 'file mtime is not conversation progress');
    assert.equal(classify({ session, snap: pane('⏺ The docs endpoint is ready.') + maintenance, idleMs: at - old, claudeActivity: result }).status,
      'waiting', `maintenance ${maintenance} never wakes the session`);
  }
  await appendFile(file, line(row('file-history-snapshot', at, { snapshot: {} }))
    + line(row('progress', at, { data: { type: 'hook_progress' } }))
    + line(row('queue-operation', at, { operation: 'remove', content: 'discarded' }))
    + line(assistant('helper', at, 'Helper done.', 'end_turn', { isSidechain: true }))
    + line(assistant('foreign', at, 'Another project.', 'end_turn', { sessionId: 'different' }))
    + line(oldReport));
  result = await observeClaudeActivity(entry, file, at);
  assert.equal(result.changed, false, 'housekeeping, helper/foreign records and old replays do not reset the clock');
  const first = assistant('report-new', at, 'First paragraph.', 'end_turn', { apiBlockIndex: 0 });
  const second = assistant('report-new', at + 1, 'Second paragraph.', 'end_turn', { uuid: 'second-block', apiBlockIndex: 1 });
  const partial = line(first);
  await appendFile(file, partial.slice(0, -5));
  assert.equal((await observeClaudeActivity(entry, file, at)).changed, false, 'partial JSON writes do not prove activity');
  await appendFile(file, partial.slice(-5) + line(second));
  result = await observeClaudeActivity(entry, file, at);
  assert.equal(result.changed, true);
  assert.equal(result.newReport, true);
  assert.equal(result.report.text, 'First paragraph.\n\nSecond paragraph.');
  assert.equal(classify({ session, snap: pane('⏺ a cropped report'), idleMs: 5000, claudeActivity: result }).question, result.report.text,
    'the source report, not viewport cropping, determines the attention identity');
  await appendFile(file, line({ ...second, uuid: 'a-different-replay-envelope' }));
  assert.equal((await observeClaudeActivity(entry, file, at)).changed, false, 'a replay does not create another report');
  const quietTool = assistant('running', at + 2, 'Running a quiet acceptance.', 'tool_use');
  await appendFile(file, line(quietTool));
  result = await observeClaudeActivity(entry, file, at);
  assert.equal(classify({ session, snap: 'quiet tool (no live completion line)', idleMs: 3600_000, claudeActivity: result }).status,
    'working', 'native unfinished turn stays working even without a visible spinner');
  const incompleteMetadata = line(row('file-history-snapshot', at + 3, { snapshot: {} }));
  await appendFile(file, incompleteMetadata.slice(0, -4));
  result = await observeClaudeActivity(entry, file, at);
  assert.equal(result.changed, false);
  assert.equal(result.newReport, false);
  assert.equal(result.phase, 'working', 'an incomplete write retains the known unfinished native turn');
  assert.equal(classify({ session, snap: pane('old done line'), idleMs: 3600_000, claudeActivity: result }).status,
    'working', 'an incomplete metadata write cannot expose a stale previous completion');
  await appendFile(file, incompleteMetadata.slice(-4));
  await observeClaudeActivity(entry, file, at);
  assert.equal(claudeActivityRecord(row('assistant', at, { message: { id: 'null-parts', content: [null, { type: 'text', text: 'Streaming.' }] } }), native, at).phase,
    'unknown', 'empty content parts do not crash the native observer');
  assert.equal(claudeActivityRecord(row('system', at), native), null);
  assert.equal(claudeActivityRecord(assistant('future', at + 120000, 'Wrong clock.'), native, at), null);
  assert.equal(claudeAttentionKey(session, ' A  report ', 2), claudeAttentionKey(session, 'A report', 2));
  assert.notEqual(claudeAttentionKey(session, 'A report', 2), claudeAttentionKey(session, 'A report', 3), 'a new request permits a new identically worded response');
  assert.equal(claudeAttentionKey(session, 'Allow Bash?', 2, 'gate-1'), claudeAttentionKey(session, 'Raw terminal wording and options', 2, 'gate-1'),
    'hook and terminal projections of the same native gate cannot reopen dismissal');
  const quoted = pane('⏺ The old log says "Working…", "approve", "Esc to interrupt" and ⣾.');
  assert.equal(classify({ session, snap: quoted, idleMs: 3600_000 }).status, 'waiting', 'completed prose cannot invent work or a live question');
  assert.equal(classify({ session, snap: pane('⏺ The old log said "4 background terminals running".'), idleMs: 20_000 }).status,
    'waiting', 'quoted task counts cannot trigger the generic ten-minute background hold in Claude');
  assert.equal(claudeTerminalFrame(pane('⏺ done').replace('done 11:13 PM', 'done 11:13 PM · 4 shells still running')
    .replace('← for agents', '0 shells · ← for agents')).count, 0, 'an explicit current zero retires an older footer count');
  const reportWithNewTimestamp = { ...session, last_key: { ts: at } };
  assert.equal(splitSessionRecency([reportWithNewTimestamp], at).older.length, 1);
  assert.equal(isRecentVoiceSession(reportWithNewTimestamp, at), false, 'old re-extracted reports cannot enter the 24-hour voice queue');
  assert.equal(splitSessionRecency([{ ...reportWithNewTimestamp, tool: 'codex' }], at).recent.length, 1, 'Codex recency semantics remain unchanged');
  rememberClaudeHook(session.id, { event: 'Stop', sent_at: old, background_tasks: [], last_assistant_message: 'Done.' });
  assert.equal(rememberClaudeHook(session.id, { event: 'Notification', sent_at: at, notification_type: 'idle_prompt' }).status, null,
    'a repeated passive reminder does not create a new waiting episode');
  clearClaudeLifecycle(session.id);
  // Oversized metadata remains bounded, including skipping a partial line at the scan boundary.
  await appendFile(file, line(row('file-history-snapshot', at, { ignored: 'x'.repeat(700000) })));
  result = await observeClaudeActivity(entry, file, at);
  assert.ok(result.scannedBytes <= 256 * 1024);
  assert.equal(result.changed, false);
  console.log(JSON.stringify({ session: session.id, scenario: 'old Claude report + repeated maintenance/replays',
    falseActivity: 0, reportReplay: 'suppressed', freshSource: 'full native report', quietNativeWork: 'working',
    recentAndVoiceQueues: 'old', readBudget: 256 * 1024, codex: 'unchanged' }));
} finally { await rm(dir, { recursive: true, force: true }); }
