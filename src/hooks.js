import { join } from 'node:path';
import { homedir } from 'node:os';
import { route, json, readJson } from './server.js';
import { setHookState } from './detect.js';
import * as store from './store.js';
import { bus } from './bus.js';
import { projectSession, sessionStatusPayload } from './session_projection.js';

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
        const previousStatus = store.getSession(sid)?.status || s.status;
        const updated = store.updateSession(sid, {
          status: 'waiting',
          question,
          last_activity: Date.now(),
        });
        store.addEvent(sid, 'hook', { tool, event });
        bus.emit('session-status', sessionStatusPayload(projectSession(updated, {
          project: updated.project_id ? store.getProject(updated.project_id) : null,
        }), {
          previousStatus,
          source: 'hook',
          extra: { tool, event },
          ts: Date.now(),
        }));
      } else if (WORKING_EVENT.test(event)) {
        setHookState(sid, 'working', null);
        const previousStatus = store.getSession(sid)?.status || s.status;
        const updated = store.updateSession(sid, {
          status: 'working',
          question: null,
          last_activity: Date.now(),
        });
        store.addEvent(sid, 'hook', { tool, event });
        bus.emit('session-status', sessionStatusPayload(projectSession(updated, {
          project: updated.project_id ? store.getProject(updated.project_id) : null,
        }), {
          previousStatus,
          source: 'hook',
          extra: { tool, event },
          ts: Date.now(),
        }));
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

console.log('[aios] hook endpoints ready (/api/hook/{claude,codex,agy})');
