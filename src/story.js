// story_parse.js — normalize agent session logs (Codex rollout JSONL + Claude Code project JSONL)
// into "story" events for the non-technical session view.
//
// Reference implementation for Supercalm. Dependency-free. CommonJS.
// Verified against:
//   data/rollout-2026-06-28T03-36-06-*.jsonl   (Codex rollout format)
//   data/92c63f25-*.jsonl                      (Claude Code project-log format)
//
// Output: array of story events, chronological:
//   { kind, ts, title, body, meta, steps: [{human, cmd}], chips: [], options: [],
//     shot, indent, durationMs, exitCode }
// kinds: you | sys | work | plan | note | sub | edit | fail | check | ship | web | report | ask | stop | gap

// (ESM conversion of the handoff drop-in — logic verbatim)

const CLUSTER_WINDOW_MS = 90_000;   // same-class calls within 90s merge into one work block
const GAP_MIN_MS = 10 * 60_000;     // idle > 10 min renders a gap divider

// ---------- command classification (Codex exec / Claude Bash) ----------
function classifyCommand(cmd) {
  const c = String(cmd || '').trim();
  if (/^git (merge|push|tag|cherry-pick)/.test(c) || /wrangler (deploy|pages)/.test(c) || /npm publish/.test(c)) return 'ship';
  if (/(npm|pnpm|yarn) (test|run test|run build)|pytest|go test|vitest|playwright|jest/.test(c)) return 'check';
  if (/^(curl|wget|http)/.test(c)) return 'web';
  if (/apply_patch|>>?\s*[^|]*\.(js|ts|css|html|md|json)\b/.test(c)) return 'edit';
  return 'work';
}

// Plain-language headline for a cluster of commands, by dominant verb.
function humanizeCluster(cmds) {
  const joined = cmds.join(' ');
  if (/git (branch|log|status|remote|diff|show)/.test(joined)) return 'Looked around the project history';
  if (/\b(rg|grep|find|ls|cat|sed -n|head|tail|wc)\b/.test(joined)) return 'Read through the code';
  if (/sqlite3|SELECT /.test(joined)) return 'Checked the database';
  if (/npm|node |pnpm/.test(joined)) return 'Ran the project tooling';
  return 'Worked in the terminal';
}

// One human line per command when no better description exists.
function humanizeCmd(cmd) {
  const c = String(cmd || '').trim();
  const m = {
    'git branch': 'Listed the work branches', 'git remote': 'Checked where the code gets published',
    'git status': 'Looked for unsaved changes', 'git log': 'Skimmed the recent history',
    'git diff': 'Compared versions of the code', 'git merge': 'Combined branches',
  };
  for (const k of Object.keys(m)) if (c.startsWith(k)) return m[k];
  if (/^(rg|grep)/.test(c)) return 'Searched the code';
  if (/^(cat|sed -n|head|tail)/.test(c)) return 'Read a file';
  if (/^ls\b/.test(c)) return 'Listed a folder';
  if (/^curl/.test(c)) return 'Fetched a page';
  return 'Ran: ' + c.slice(0, 60);
}

const CLAUDE_TOOL_KIND = {
  Read: 'work', Grep: 'work', Glob: 'work', Bash: null /* classify by command */,
  Edit: 'edit', Write: 'edit', NotebookEdit: 'edit', MultiEdit: 'edit',
  WebFetch: 'web', WebSearch: 'web', TodoWrite: 'plan', Task: 'sub',
  AskUserQuestion: 'ask', ExitPlanMode: 'plan',
};

// ---------- per-format extraction: raw atoms ----------
// atom: { ts, kind, human, cmd, text, title, options, exitCode, durationMs, indent }

function atomsFromCodex(lines) {
  const atoms = [];
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    const ts = Date.parse(j.timestamp) || 0;
    const p = j.payload || {};
    if (j.type === 'session_meta') {
      atoms.push({ ts, kind: 'sys', text: `Session started — ${p.originator || 'codex'} · cli ${p.cli_version || ''} · in ${String(p.cwd || '').split('/').pop()}` });
    } else if (j.type === 'turn_context') {
      // model/effort changes could be surfaced; skip unless it differs from previous (left to caller)
    } else if (j.type === 'event_msg') {
      const t = p.type;
      if (t === 'user_message') atoms.push({ ts, kind: 'you', text: p.message });
      else if (t === 'agent_message') atoms.push({ ts, kind: p.phase === 'final' ? 'report' : 'note', text: p.message });
      else if (t === 'turn_aborted' || t === 'interrupted') atoms.push({ ts, kind: 'stop', text: 'You interrupted the agent' });
    } else if (j.type === 'response_item') {
      const t = p.type;
      if (t === 'function_call') {
        let args = {}; try { args = JSON.parse(p.arguments || '{}'); } catch {}
        const cmd = args.cmd || p.name;
        const kind = p.name === 'update_plan' ? 'plan' : classifyCommand(cmd);
        atoms.push({ ts, kind, cmd, human: humanizeCmd(cmd), callId: p.call_id });
      } else if (t === 'function_call_output') {
        const m = /exited with code (\d+)/.exec(p.output || '');
        if (m && Number(m[1]) !== 0) atoms.push({ ts, kind: 'fail', text: firstLines(p.output, 2), exitCode: Number(m[1]) });
      } else if (t === 'reasoning') {
        atoms.push({ ts, kind: '_thinking' }); // duration only
      }
    }
  }
  return atoms;
}

function atomsFromClaude(lines) {
  const atoms = [];
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    const ts = Date.parse(j.timestamp) || 0;
    const indent = !!j.isSidechain;
    if (j.type === 'user' && j.message) {
      const c = j.message.content;
      if (typeof c === 'string') {
        if (/\[Request interrupted/.test(c)) atoms.push({ ts, kind: 'stop', text: 'You interrupted the agent' });
        else atoms.push({ ts, kind: 'you', text: c });
      } else if (Array.isArray(c)) {
        for (const part of c) {
          if (part.type === 'tool_result' && part.is_error) atoms.push({ ts, kind: 'fail', text: firstLines(textOf(part.content), 2), indent });
        }
      }
    } else if (j.type === 'assistant' && j.message) {
      for (const part of j.message.content || []) {
        if (part.type === 'text' && part.text) atoms.push({ ts, kind: 'note', text: part.text, indent }); // final text => report (caller promotes last one)
        else if (part.type === 'thinking') atoms.push({ ts, kind: '_thinking', indent });
        else if (part.type === 'tool_use') {
          const base = CLAUDE_TOOL_KIND[part.name];
          const kind = base === null ? classifyCommand(part.input?.command) : (base || 'work');
          atoms.push({
            ts, kind, indent,
            cmd: part.input?.command || part.name + ' ' + (part.input?.file_path || part.input?.pattern || ''),
            human: part.input?.description || humanizeCmd(part.input?.command || part.name),
            title: part.name === 'Task' ? (part.input?.description || 'Sent a helper agent') : undefined,
            options: part.name === 'AskUserQuestion' ? (part.input?.questions?.[0]?.options || []) : undefined,
            text: part.name === 'AskUserQuestion' ? part.input?.questions?.[0]?.question : undefined,
          });
        }
      }
    }
    // hidden: attachment, file-history-snapshot, mode, permission-mode, last-prompt (no story value)
    // ai-title handled by caller for the session title.
  }
  return atoms;
}

// ---------- clustering: atoms -> story events ----------
function buildStory(atoms) {
  const out = [];
  let cluster = null;
  const flush = () => { if (cluster) { out.push(cluster); cluster = null; } };
  let lastTs = 0;

  for (const a of atoms) {
    if (a.kind === '_thinking') continue; // folded into durations
    if (lastTs && a.ts - lastTs > GAP_MIN_MS) { flush(); out.push({ kind: 'gap', ts: a.ts, durationMs: a.ts - lastTs }); }
    lastTs = a.ts || lastTs;

    const clusterable = a.kind === 'work' || a.kind === 'web' || a.kind === 'edit' || a.kind === 'check';
    if (clusterable) {
      if (cluster && cluster.kind === a.kind && !!cluster.indent === !!a.indent && a.ts - cluster.lastTs <= CLUSTER_WINDOW_MS) {
        cluster.steps.push({ human: a.human, cmd: a.cmd });
        cluster.lastTs = a.ts;
      } else {
        flush();
        cluster = { kind: a.kind, ts: a.ts, lastTs: a.ts, indent: a.indent, steps: [{ human: a.human, cmd: a.cmd }] };
      }
      continue;
    }
    flush();
    out.push({ kind: a.kind, ts: a.ts, title: a.title, body: a.text, options: a.options, exitCode: a.exitCode, indent: a.indent });
  }
  flush();

  for (const ev of out) {
    if (ev.steps) {
      ev.title = ev.kind === 'work' ? humanizeCluster(ev.steps.map(s => s.cmd || '')) :
                 ev.kind === 'web' ? 'Looked things up online' :
                 ev.kind === 'edit' ? 'Made changes to the code' : 'Ran the checks';
      ev.meta = ev.steps.length + (ev.steps.length === 1 ? ' step' : ' steps') +
                (ev.lastTs > ev.ts ? ' · ' + Math.max(1, Math.round((ev.lastTs - ev.ts) / 1000)) + 's' : '');
    }
  }
  // promote the last trailing 'note' to 'report' (Claude final text / Codex already tagged)
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].kind === 'note') { out[i].kind = 'report'; break; }
    if (out[i].kind !== 'gap') break;
  }
  return out;
}

function textOf(c) { return typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x.text || '').join('\n') : ''; }
function firstLines(s, n) { return String(s || '').split('\n').slice(0, n).join(' · ').slice(0, 300); }

function detectFormat(firstLine) {
  try { const j = JSON.parse(firstLine); return j.payload !== undefined ? 'codex' : 'claude'; } catch { return 'claude'; }
}

function parseSessionLog(jsonlText) {
  const lines = String(jsonlText).split('\n').filter(Boolean);
  if (!lines.length) return [];
  const fmt = detectFormat(lines[0]);
  const atoms = fmt === 'codex' ? atomsFromCodex(lines) : atomsFromClaude(lines);
  const out = buildStory(atoms);
  // R2 S7: an ask followed by any later operator input is ANSWERED — the server data must agree
  // with the client's optimistic stamp, or the next refetch resurrects the buttons.
  for (let i = 0; i < out.length; i++) {
    if (out[i].kind !== 'ask') continue;
    const reply = out.slice(i + 1).find((e) => e.kind === 'you');
    if (reply) {
      out[i].answered = true;
      out[i].answeredWith = String(reply.body || reply.title || '').split('\n')[0].slice(0, 60);
    }
  }
  return out;
}

export { parseSessionLog, classifyCommand, humanizeCmd, buildStory, atomsFromCodex, atomsFromClaude };
