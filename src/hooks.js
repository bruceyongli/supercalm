import { join } from 'node:path';
import { homedir } from 'node:os';
import { route, json, readJson } from './server.js';
import { setHookState } from './detect.js';
import { noteAgentStatus, repairMissingAttentionReport } from './sessions.js';
import * as store from './store.js';

// Only paths inside claude's own project store are bindable — the value is later stat/read by the
// story view, so a forged hook POST must not be able to point it at an arbitrary file.
const CLAUDE_PROJECTS_ROOT = join(homedir(), '.claude', 'projects') + '/';

// Tools POST lifecycle events here so Supercalm knows precisely when a session is
// working vs waiting. The session id arrives as the AIOS_SESSION_ID we injected
// at launch (passed through by the hook command / notify script).
//
//   claude:  Notification, Stop          -> waiting ;  UserPromptSubmit -> working
//   codex:   agent-turn-complete         -> waiting ;  (others)         -> working

const WAITING_EVENT = /notification|stop|turn[-_. ]?complete|approval|idle|needs?[-_. ]?input/i;
const WORKING_EVENT = /prompt|submit|start|pre[-_. ]?tool|exec|begin|active|running/i;
const _waitingSessions = store.db.prepare("SELECT id FROM sessions WHERE status = 'waiting'");
const _latestHook = store.db.prepare("SELECT ts, payload FROM events WHERE session_id = ? AND type = 'hook' ORDER BY id DESC LIMIT 1");
const _latestInput = store.db.prepare("SELECT id, ts FROM messages WHERE session_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1");
const _latestOutput = store.db.prepare("SELECT id FROM messages WHERE session_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1");

// Older completion hooks persisted status='waiting' without creating the durable report that powers
// Needs You. Repair only the exact stranded shape on boot: latest hook says waiting, it is not older
// than the latest operator input, and there is no report after that input. Reviewed/dismissed reports
// already have a newer output row and remain untouched.
export function repairMissedHookAttention() {
  const repaired = [];
  for (const { id } of _waitingSessions.all()) {
    const hook = _latestHook.get(id);
    if (!hook) continue;
    let event = '';
    try { event = String(JSON.parse(hook.payload || '{}').event || ''); } catch {}
    if (!WAITING_EVENT.test(event)) continue;
    const input = _latestInput.get(id);
    const output = _latestOutput.get(id);
    if (input && Number(hook.ts) < Number(input.ts)) continue;
    if (output && Number(output.id) > Number(input?.id || 0)) continue;
    const result = repairMissingAttentionReport(id, { extra: { event, recovered: true } });
    if (result.repaired) repaired.push(id);
  }
  return repaired;
}

function handle(tool, b, res) {
  const sid = b.session || b.session_id || b['session-id'];
  const event = String(b.event || b.type || b.hook_event_name || '').trim();
  if (sid && event) {
    const s = store.getSession(sid);
    if (s && s.status !== 'exited') {
      // Bind the exact transcript identity: claude pipes transcript_path in every hook payload, and the
      // story view targets THIS file instead of guessing by cwd+size (which bled the biggest transcript
      // into every concurrent same-cwd session's story). Self-heals on every event (resume may move it).
      const tp = String(b.transcript || b.transcript_path || '');
      if (tool === 'claude' && tp && tp !== s.claude_transcript && tp.length < 512
          && tp.endsWith('.jsonl') && tp.startsWith(CLAUDE_PROJECTS_ROOT) && !tp.includes('..')) {
        store.updateSession(sid, { claude_transcript: tp });
        store.addEvent(sid, 'transcript-bind', { path: tp });
      }
      if (WAITING_EVENT.test(event)) {
        const question = b.message || b.question || null;
        setHookState(sid, 'waiting', question);
        store.addEvent(sid, 'hook', { tool, event });
        noteAgentStatus(sid, 'waiting', question, { source: 'hook', extra: { tool, event } });
      } else if (WORKING_EVENT.test(event)) {
        setHookState(sid, 'working', null);
        store.addEvent(sid, 'hook', { tool, event });
        noteAgentStatus(sid, 'working', null, { source: 'hook', extra: { tool, event } });
      }
    }
  }
  json(res, 200, { ok: true });
}

for (const tool of ['claude', 'codex', 'agy']) {
  route('POST', `/api/hook/${tool}`, async (req, res) => {
    const b = await readJson(req).catch(() => ({}));
    handle(tool, b, res);
  });
}

const repaired = repairMissedHookAttention();
if (repaired.length) console.log(`[aios] recovered ${repaired.length} missed hook attention report(s)`);

console.log('[aios] hook endpoints ready (/api/hook/{claude,codex,agy})');
