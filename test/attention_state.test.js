import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-attention-'));

const { db, addMessage } = await import('../src/store.js');
const {
  attentionUnreadCount,
  clearAttentionDismissal,
  createAttentionReport,
  dismissAttention,
  getAttentionDismissal,
  restoreAttention,
} = await import('../src/attention_store.js');
const { initialMonitorLastChange, observeMonitorSnapshot } = await import('../src/session_monitor_state.js');

db.prepare(`
  INSERT INTO sessions
    (id, project_id, tool, tmux, title, status, category, started_at, last_activity)
  VALUES ('s_attention', NULL, 'codex', 'tmx_attention', 'Attention test', 'waiting', 'review', 1, 100)
`).run();

const first = createAttentionReport('s_attention', 'Choose a deployment window');
assert.equal(first.created, true);
assert.equal(attentionUnreadCount('s_attention'), 1);

const dismissal = dismissAttention('s_attention', first.message.id, 200);
assert.equal(dismissal.dismissed, true);
assert.equal(attentionUnreadCount('s_attention'), 0);
assert.equal(getAttentionDismissal('s_attention').report_id, first.message.id);

const duplicate = createAttentionReport('s_attention', '  Choose a deployment   window ');
assert.equal(duplicate.created, false, 'an identical report with no operator input is the same episode');
assert.equal(getAttentionDismissal('s_attention').report_id, first.message.id, 'a restart duplicate cannot reopen a dismissal');

addMessage('s_attention', 'in', 'text', 'Tomorrow at 9');
const genuinelyNew = createAttentionReport('s_attention', 'Choose a deployment window');
assert.equal(genuinelyNew.created, true, 'operator input creates an episode boundary even when wording repeats');
clearAttentionDismissal('s_attention');
assert.equal(getAttentionDismissal('s_attention'), null);
assert.equal(attentionUnreadCount('s_attention'), 1);

dismissAttention('s_attention', genuinelyNew.message.id, 300);
const restored = restoreAttention('s_attention');
assert.equal(restored.reopened, true);
assert.equal(restored.unread, 1);
assert.equal(getAttentionDismissal('s_attention'), null);

// A waiting row keeps its persisted idle clock on first observation. Subsequent pane movement is real.
const entry = { lastHash: null, lastChange: initialMonitorLastChange({ status: 'waiting', last_activity: 123 }, 1000) };
assert.equal(entry.lastChange, 123);
assert.equal(observeMonitorSnapshot(entry, 'pane-a', 'waiting', 1000), false);
assert.equal(entry.lastChange, 123, 'boot hydration never fabricates activity');
assert.equal(observeMonitorSnapshot(entry, 'pane-b', 'waiting', 1100), true);
assert.equal(entry.lastChange, 1100);

console.log('attention_state.test ok');
