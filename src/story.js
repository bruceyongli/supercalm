// src/story.js — normalize agent session logs (Codex rollout JSONL + Claude Code project JSONL)
// into "story" events for the non-technical session view.  FIXPACK r4 — full replacement.
//
// r3 fixes (verified against the real files in data/):
//  F1  Codex user turns: rollouts log them as response_item {type:"message",role:"user",
//      content:[{type:"input_text"}]} — previously unhandled, so Codex stories had NO "You said"
//      events and answered questions kept resurrecting their buttons (S7 depended on `you` events).
//  F2  Injected-context stripping: <project_context>/<relevant_lessons>/<user_instructions>/
//      <environment_context>/<system-reminder> walls and TUI scrollback echo are cut; a long turn
//      keeps its last human-written paragraph (that's where the real message lives).
//  F3  exec_command args use {cmd:"..."} (string) — kept; ALSO tolerate {command:[...]} array
//      shapes (shell/local_shell variants) so other codex builds parse too.
//  F4  Benign non-zero exits are no longer red FAIL cards: exit 1 from rg/grep/fd/find/diff/test
//      is a no-match, not an error (callId→cmd map consulted).
//  F5  function_call_output exit codes: parse JSON {metadata:{exit_code}} / {exit_code} first,
//      fall back to the "exited with code N" regex.
//  F6  request_user_input → ask event (question + options); first turn_context → one sys line
//      (model · effort).
//  F7  Claude user messages with array {type:"text"} content parts are no longer dropped.
//  F8  Gap events carry a human title ("quiet for 25m — parked until you answer" when they follow
//      an unanswered ask).
//  F9  event_msg/user_message deduped against F1 (same text within 5s).
//  r4 (from production screenshots, 2026-07-11):
//  F10 fail events get a human title ("Hit a snag") and XML/HTML tags are stripped from ALL
//      bodies (<tool_use_error> was rendering verbatim).
//  F11 (superseded 2026-07-15): note/report bodies now KEEP their markdown — the story view renders
//      it as rich content (tables/headings/code, cleanRich + web renderMarkdown); deMd remains for
//      fail/sub one-liners only.
//  F12 Claude tool-name steps humanized (Read/Grep/Edit + trailing filename) — no more "Ran: Read".
//  F13 1-step clusters stop saying "1 step" twice (meta carries duration only).
//
// Output: array of story events, chronological:
//   { kind, ts, title, body, meta, steps: [{human, cmd}], chips: [], options: [],
//     shot, indent, durationMs, exitCode, answered, answeredWith }
// kinds: you | sys | work | plan | note | sub | edit | fail | check | ship | web | report | ask | stop | gap

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
  if (/\b(rg|grep|find|fd|ls|cat|sed -n|head|tail|wc)\b/.test(joined)) return 'Read through the code';
  if (/\b(Read|Grep|Glob|LS)\b/.test(joined)) return 'Read through the code';           // Claude tool names
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
  const fname = (s) => { const mm = /([\w.-]+\.[A-Za-z]{1,8})\s*$/.exec(s); return mm ? ' (' + mm[1] + ')' : ''; };
  if (/^Read\b/.test(c)) return 'Read a file' + fname(c);
  if (/^(Grep|Glob|LS)\b/.test(c)) return 'Searched the code';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)\b/.test(c)) return 'Edited a file' + fname(c);
  if (/^(WebFetch|WebSearch)\b/.test(c)) return 'Looked something up online';
  if (/^(rg|grep|fd)/.test(c)) return 'Searched the code';
  if (/^(cat|sed -n|head|tail)/.test(c)) return 'Read a file';
  if (/^ls\b/.test(c)) return 'Listed a folder';
  if (/^curl/.test(c)) return 'Fetched a page';
  return 'Ran: ' + c.slice(0, 60);
}

const CLAUDE_TOOL_KIND = {
  Read: 'work', Grep: 'work', Glob: 'work', LS: 'work', Bash: null /* classify by command */,
  Edit: 'edit', Write: 'edit', NotebookEdit: 'edit', MultiEdit: 'edit',
  WebFetch: 'web', WebSearch: 'web', TodoWrite: 'plan', Task: 'sub',
  AskUserQuestion: 'ask', ExitPlanMode: 'plan',
};

// ---------- F2: injected-context stripping ----------
const INJECT_BLOCKS = /<(project_context|relevant_lessons|user_instructions|environment_context|system-reminder|INSTRUCTIONS|collaboration_mode)>[\s\S]*?<\/\1>/g;
function cleanUserText(raw) {
  let t = String(raw || '').replace(INJECT_BLOCKS, '').trim();
  if (!t) return '';
  // Compaction/continuation summaries are machine context, not conversation. The last-paragraph
  // heuristic below would otherwise surface a QUOTED OLD MESSAGE from inside the summary as a fresh
  // operator bubble (seen live: June "request failed 405" texts rendered unattributed in July stories).
  if (/^\s*(This session is being continued from a previous conversation|<summary>|Caveat: the messages below were generated)/i.test(t)) return '';
  // Hook-injected feedback (Claude Code Stop / PreToolUse / PostToolUse / UserPromptSubmit / … hooks) is
  // delivered as a user-ROLE turn but is MACHINE content, not the operator — never render it as a "you"
  // bubble. (Operator report: a "Stop hook feedback: …" task evaluation showed up as their own message.)
  if (/^\s*(?:[A-Za-z][\w-]* )?hook feedback\b/i.test(t) || /^\s*<(?:user-prompt-submit-hook|hook)[\s>]/i.test(t)) return '';
  // CLI-harness attachment metadata rides along with an operator's image message but is TOOLING text,
  // not their words: the "Attached files available locally…" manifest and the "[Image: original WxH,
  // displayed at WxH. Multiply coordinates by N…]" dimension annotation. Rendered on its own, that
  // annotation REPLACED the operator's actual message in the story (operator report: "what hack the
  // message get rotated to this?"). Strip both so their real text shows (and an annotation-only turn
  // collapses to empty → dropped, not surfaced as a "you" bubble).
  t = t.replace(/\n+\s*Attached files? available locally to this coding CLI:[\s\S]*$/i, '').trim();
  t = t.replace(/\[Image:\s*original\s+\d+x\d+[^\]]*\]/gi, '').trim();
  if (!t) return '';
  // Only VERY long turns (thousands of chars) are context/scrollback echo with the real message as the
  // last paragraph. A genuine multi-paragraph operator message (their side-nav + story requirements ran
  // ~1.5k chars) must NOT be reduced to its last paragraph or clipped — operator report: "my message in
  // the story was cut off." So the echo heuristic + the hard cap only kick in above a generous ceiling.
  const CEIL = 4000;
  if (t.length > CEIL) {
    const paras = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    for (let i = paras.length - 1; i >= 0; i--) {
      const p = paras[i];
      if (p.length >= 8 && !/^[<✻✳❯│└─\s]/.test(p) && !/^\(\d\)/.test(p)) { t = p; break; }
    }
  }
  if (t.length > CEIL) t = t.slice(0, CEIL) + '…';
  return t;
}

// ---------- per-format extraction: raw atoms ----------
// atom: { ts, kind, human, cmd, text, title, options, exitCode, durationMs, indent }

function atomsFromCodex(lines) {
  const atoms = [];
  const callCmd = new Map(); // call_id -> cmd (F4)
  let sawTurnCtx = false;
  const pushYou = (ts, raw) => {
    const text = cleanUserText(raw);
    if (!text) return;
    // F9: dedupe against an event_msg/user_message twin
    const dup = atoms.slice(-4).some((a) => a.kind === 'you' && Math.abs(a.ts - ts) < 5000 && a.text.slice(0, 120) === text.slice(0, 120));
    if (!dup) atoms.push({ ts, kind: 'you', text });
  };
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    const ts = Date.parse(j.timestamp) || 0;
    const p = j.payload || {};
    if (j.type === 'session_meta') {
      atoms.push({ ts, kind: 'sys', text: `Session started — ${p.originator || 'codex'} · cli ${p.cli_version || ''} · in ${String(p.cwd || '').split('/').pop()}` });
    } else if (j.type === 'turn_context') {
      if (!sawTurnCtx && (p.model || p.effort)) {
        sawTurnCtx = true;
        atoms.push({ ts, kind: 'sys', text: ['model ' + (p.model || '?'), p.effort ? 'effort ' + p.effort : ''].filter(Boolean).join(' · ') });
      }
    } else if (j.type === 'event_msg') {
      const t = p.type;
      if (t === 'user_message') pushYou(ts, p.message);
      else if (t === 'agent_message') atoms.push({ ts, kind: p.phase === 'final' ? 'report' : 'note', text: p.message });
      else if (t === 'turn_aborted' || t === 'interrupted') atoms.push({ ts, kind: 'stop', text: 'You interrupted the agent' });
    } else if (j.type === 'response_item') {
      const t = p.type;
      if (t === 'message' && p.role === 'user') {
        // F1: real rollouts log user turns here (content: [{type:"input_text",text}])
        const raw = (p.content || []).filter((c) => c.type === 'input_text' || c.type === 'text').map((c) => c.text || '').join('\n');
        pushYou(ts, raw);
      } else if (t === 'function_call') {
        let args = {}; try { args = JSON.parse(p.arguments || '{}'); } catch {}
        // F3: cmd string (exec_command) OR command array (shell variants)
        let cmd = args.cmd || (Array.isArray(args.command) ? args.command.join(' ').replace(/^(bash|sh|zsh) -lc /, '') : args.command) || p.name;
        if (p.name === 'update_plan') {
          const chips = (args.plan || args.steps || []).map((s) => (typeof s === 'string' ? s : s.step || s.title || '')).filter(Boolean).slice(0, 6);
          atoms.push({ ts, kind: 'plan', title: 'Made a plan', chips });
        } else if (p.name === 'request_user_input') {
          // F6: codex asks arrive as a tool call
          const q = args.question || args.prompt || (args.questions?.[0]?.question) || 'Needs your decision';
          const options = (args.options || args.questions?.[0]?.options || []).map((o) => (typeof o === 'string' ? { label: o } : o));
          atoms.push({ ts, kind: 'ask', title: 'Needs your decision', text: q, options });
        } else {
          if (p.call_id) callCmd.set(p.call_id, cmd);
          atoms.push({ ts, kind: classifyCommand(cmd), cmd, human: humanizeCmd(cmd), callId: p.call_id });
        }
      } else if (t === 'function_call_output') {
        // F5: exit code from JSON metadata first, regex fallback
        let exit = null, outText = '';
        const rawOut = typeof p.output === 'string' ? p.output : JSON.stringify(p.output || '');
        try {
          const o = JSON.parse(rawOut);
          exit = o?.metadata?.exit_code ?? o?.exit_code ?? null;
          outText = String(o?.output ?? o?.stdout ?? rawOut);
        } catch { outText = rawOut; }
        if (exit == null) { const m = /exited with code (\d+)/.exec(outText); if (m) exit = Number(m[1]); }
        if (exit != null && exit !== 0) {
          const cmd = callCmd.get(p.call_id) || '';
          const benign = exit === 1 && /^\s*(rg|grep|fd|find|diff|test|\[\[|cmp|which)\b/.test(cmd); // F4
          if (!benign) atoms.push({ ts, kind: 'fail', title: 'Hit a snag', text: firstLines(deMd(outText), 2), exitCode: exit });
        }
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
        else { const text = cleanUserText(c); if (text) atoms.push({ ts, kind: 'you', text }); }
      } else if (Array.isArray(c)) {
        for (const part of c) {
          if (part.type === 'text' && part.text) {
            // F7: array-content user turns were dropped before
            if (/\[Request interrupted/.test(part.text)) atoms.push({ ts, kind: 'stop', text: 'You interrupted the agent' });
            else { const text = cleanUserText(part.text); if (text) atoms.push({ ts, kind: 'you', text, indent }); }
          } else if (part.type === 'tool_result' && part.is_error) {
            atoms.push({ ts, kind: 'fail', title: 'Hit a snag', text: firstLines(deMd(textOf(part.content)), 2), indent });
          }
        }
      }
    } else if (j.type === 'assistant' && j.message) {
      for (const part of j.message.content || []) {
        if (part.type === 'text' && part.text) atoms.push({ ts, kind: 'note', text: part.text, indent }); // final text => report (promoted below)
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
    out.push({ kind: a.kind, ts: a.ts, title: a.title, body: a.text, options: a.options, exitCode: a.exitCode, indent: a.indent, chips: a.chips });
  }
  flush();

  for (const ev of out) {
    if (ev.steps) {
      ev.title = ev.kind === 'work' ? humanizeCluster(ev.steps.map(s => s.cmd || '')) :
                 ev.kind === 'web' ? 'Looked things up online' :
                 ev.kind === 'edit' ? 'Made changes to the code' : 'Ran the checks';
      const dur = ev.lastTs > ev.ts ? Math.max(1, Math.round((ev.lastTs - ev.ts) / 1000)) + 's' : '';
      ev.meta = ev.steps.length === 1 ? dur : ev.steps.length + ' steps' + (dur ? ' · ' + dur : '');
    }
  }
  // note/report bodies KEEP their markdown — the story view renders it (tables/headings/code as
  // rich content, web/story-view.js renderMarkdown). Only tool/XML noise is stripped. fail/sub
  // stay de-markdowned: they're clipped one-liners, not documents.
  for (const ev of out) {
    if (!ev.body) continue;
    if (ev.kind === 'note' || ev.kind === 'report') ev.body = cleanRich(ev.body);
    else if (ev.kind === 'sub' || ev.kind === 'fail') ev.body = deMd(ev.body);
  }
  // Promote each agent turn's FINAL 'note' to 'report' so EVERY historical report gets the listen
  // control, not just the newest (operator: "voice report should appear in all history reports").
  // Claude emits ALL assistant text as notes (interleaved with tool calls); a note is that turn's
  // report when the next non-gap event hands back to the operator ('you') or ends the story. Codex
  // already tags phase:final as report. Short mid-turn narration that slips through is filtered by
  // the story view's >200-char listen guard, so this only ever adds buttons to real reports.
  for (let i = 0; i < out.length; i++) {
    if (out[i].kind !== 'note') continue;
    let j = i + 1;
    while (j < out.length && out[j].kind === 'gap') j++;
    if (j >= out.length || out[j].kind === 'you') out[i].kind = 'report';
  }
  return out;
}

// Rich-body cleaner (replaces deMd for note/report — operator: "story view is not displaying
// reports with table or rich content"): PRESERVE the markdown for the client to render; strip only
// XML/tool tags (<tool_use_error> etc), and only OUTSIDE code — a fenced sample's JSX or an inline
// `<base href>` mention is content, not noise. The client escapes everything before rendering
// (common.js renderMarkdown), so what survives here is safe either way.
function stripTagsOutsideCode(s) {
  return String(s).split(/(```[\s\S]*?(?:```|$))/).map((seg, i) => {
    if (i % 2) return seg; // inside a ``` fence
    return seg.split(/(`[^`\n]*`)/).map((sp, j) => (j % 2 ? sp : sp.replace(/<\/?[a-z_][^>]*>/gi, ''))).join('');
  }).join('');
}
function cleanRich(s) {
  return stripTagsOutsideCode(String(s || '')).replace(/\n{3,}/g, '\n\n').trim();
}

// F10/F11: strip XML tags + light de-markdown so agent reports read as prose, not source.
function deMd(s) {
  let t = String(s || '');
  t = t.replace(/<\/?[a-z_][^>]*>/gi, '');                                  // <tool_use_error> etc
  t = t.replace(/^\s*\|?\s*:?-{2,}[-:| ]*$/gm, '');                       // table rules
  t = t.replace(/^\s*\|(.+)\|\s*$/gm, (m, row) => row.split('|').map((c) => c.trim()).filter(Boolean).join(' — '));
  t = t.replace(/^#{1,6}\s*/gm, '');                                        // headings
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'); // bold/code markers
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
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
  // S7: an ask followed by any later operator input is ANSWERED — the server data must agree
  // with the client's optimistic stamp, or the next refetch resurrects the buttons.
  for (let i = 0; i < out.length; i++) {
    if (out[i].kind !== 'ask') continue;
    const reply = out.slice(i + 1).find((e) => e.kind === 'you');
    if (reply) {
      out[i].answered = true;
      out[i].answeredWith = String(reply.body || reply.title || '').split('\n')[0].slice(0, 60);
    }
  }
  // F8: gap titles (needs `answered` above)
  for (let i = 0; i < out.length; i++) {
    if (out[i].kind !== 'gap') continue;
    const mins = Math.max(1, Math.round((out[i].durationMs || 0) / 60000));
    const prev = out.slice(0, i).reverse().find((e) => e.kind !== 'gap');
    out[i].title = `quiet for ${mins >= 60 ? Math.round(mins / 6) / 10 + ' hr' : mins + ' min'}` +
      (prev && prev.kind === 'ask' && !prev.answered ? ' — parked until you answer' : '');
  }
  return out;
}

export { parseSessionLog, classifyCommand, humanizeCmd, buildStory, atomsFromCodex, atomsFromClaude };
