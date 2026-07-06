import { route, json, readJson } from './server.js';
import { setHookState } from './detect.js';
import * as store from './store.js';
import { bus } from './bus.js';

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
      if (WAITING_EVENT.test(event)) {
        const question = b.message || b.question || null;
        setHookState(sid, 'waiting', question);
        store.addEvent(sid, 'hook', { tool, event });
        bus.emit('session-status', {
          session: sid,
          status: 'waiting',
          previousStatus: s.status,
          question,
          source: 'hook',
          tool,
          event,
          ts: Date.now(),
        });
      } else if (WORKING_EVENT.test(event)) {
        setHookState(sid, 'working', null);
        store.addEvent(sid, 'hook', { tool, event });
        bus.emit('session-status', {
          session: sid,
          status: 'working',
          previousStatus: s.status,
          question: null,
          source: 'hook',
          tool,
          event,
          ts: Date.now(),
        });
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
