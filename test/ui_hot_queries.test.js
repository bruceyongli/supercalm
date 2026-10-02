import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CORE_MIGRATIONS } from '../src/schema_migrations.js';
import { readFileSync } from 'node:fs';

const db = new DatabaseSync(':memory:');
try {
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY,session_id TEXT,ts INTEGER,direction TEXT,source TEXT,text TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY,session_id TEXT,ts INTEGER,type TEXT,payload TEXT);
    CREATE INDEX idx_messages_session ON messages(session_id,ts);
    CREATE INDEX idx_messages_in_session_ts ON messages(session_id,ts) WHERE direction='in';
    CREATE INDEX idx_events_session ON events(session_id,ts);`);
  CORE_MIGRATIONS.find(m => m.id === '0006_hot_ui_query_indexes').up(db);
  const touch = "SELECT session_id,MAX(ts) FROM messages WHERE direction='in' AND source IN ('text','voice','text+attachments') GROUP BY session_id";
  const touchPlan = db.prepare('EXPLAIN QUERY PLAN ' + touch).all();
  assert.ok(touchPlan.some(row => row.detail.includes('idx_messages_operator_touch')), JSON.stringify(touchPlan));
  const archive = "SELECT id,ts,payload FROM events WHERE session_id=? AND type='composer-draft-archived' ORDER BY id DESC LIMIT ?";
  assert.ok(db.prepare('EXPLAIN QUERY PLAN ' + archive).all('s_hot', 50).some(row => row.detail.includes('idx_events_composer_history')));
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(1, 's_hot', 9, 'in', 'voice', 'new request');
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(2, 's_hot', 20, 'in', 'agent:supervisor', 'not operator');
  assert.deepEqual({ ...db.prepare(touch).get() }, { session_id: 's_hot', 'MAX(ts)': 9 });
  const session = readFileSync(new URL('../web/session.js', import.meta.url), 'utf8');
  assert.ok(session.includes('api/session/${reqId}?surface=header'), 'header/settings never fetch raw history or a terminal snapshot');
  const phone = readFileSync(new URL('../web/phone.js', import.meta.url), 'utf8');
  assert.ok(phone.includes("'?surface=phone'"), 'phone only requests the messages it renders');
  assert.ok(phone.includes('detailRequests.has(sid)'), 'phone live updates coalesce overlapping detail requests');
} finally { db.close(); }
console.log('ui_hot_queries: covering recency index, bounded composer archive and lean header passed');
