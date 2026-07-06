import { createHash } from 'node:crypto';
import {
  EventType,
  RunStartedEventSchema,
  RunFinishedEventSchema,
  RunErrorEventSchema,
  StateSnapshotEventSchema,
  MessagesSnapshotEventSchema,
  TextMessageStartEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  StepStartedEventSchema,
  StepFinishedEventSchema,
  ToolCallStartEventSchema,
  ToolCallResultEventSchema,
  ToolCallEndEventSchema,
  CustomEventSchema,
} from '@ag-ui/core';

const SCHEMA_VERSION = 1;
const TEXT_PREVIEW = 360;
const TERMINAL_PREVIEW_LINES = 16;
const PATCH_PREVIEW_LINES = 160;

const EVENT_SCHEMAS = {
  [EventType.RUN_STARTED]: RunStartedEventSchema,
  [EventType.RUN_FINISHED]: RunFinishedEventSchema,
  [EventType.RUN_ERROR]: RunErrorEventSchema,
  [EventType.STATE_SNAPSHOT]: StateSnapshotEventSchema,
  [EventType.MESSAGES_SNAPSHOT]: MessagesSnapshotEventSchema,
  [EventType.TEXT_MESSAGE_START]: TextMessageStartEventSchema,
  [EventType.TEXT_MESSAGE_CONTENT]: TextMessageContentEventSchema,
  [EventType.TEXT_MESSAGE_END]: TextMessageEndEventSchema,
  [EventType.STEP_STARTED]: StepStartedEventSchema,
  [EventType.STEP_FINISHED]: StepFinishedEventSchema,
  [EventType.TOOL_CALL_START]: ToolCallStartEventSchema,
  [EventType.TOOL_CALL_RESULT]: ToolCallResultEventSchema,
  [EventType.TOOL_CALL_END]: ToolCallEndEventSchema,
  [EventType.CUSTOM]: CustomEventSchema,
};

function stableHash(value) {
  return createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function stableId(prefix, ...parts) {
  const raw = parts.map((p) => String(p ?? '')).filter(Boolean).join(':');
  const safe = raw.replace(/[^A-Za-z0-9_.:-]/g, '-').replace(/-+/g, '-').slice(0, 80);
  return `${prefix}:${safe || stableHash(raw)}:${stableHash(raw)}`;
}

function tsValue(ts) {
  const n = Date.parse(ts) || Number(ts);
  return Number.isFinite(n) ? n : 0;
}

function sortByTime(items = []) {
  return [...items].sort((a, b) => tsValue(a.ts) - tsValue(b.ts) || String(a.id || '').localeCompare(String(b.id || '')));
}

function compactText(text, max = TEXT_PREVIEW) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1)).trimEnd()}...` : s;
}

function sourceRef(b = {}) {
  return {
    blockId: b.id || null,
    type: b.type || null,
    subtype: b.subtype || null,
    role: b.role || null,
    title: b.title || null,
    ts: b.ts || null,
  };
}

function unique(items = []) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const v = String(item || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function countLines(text = '') {
  const s = String(text || '');
  if (!s) return 0;
  return s.split(/\r?\n/).filter((line) => line.trim()).length;
}

function roleForAgui(role) {
  if (role === 'user') return 'user';
  if (role === 'system' || role === 'developer') return role;
  return 'assistant';
}

function attachmentsForBlock(b = {}) {
  return b.attachments || (b.attachment ? [b.attachment] : []);
}

function normalizeAttachment(a = {}, b = {}) {
  const format = a.format || (a.type ? String(a.type).split('/').pop()?.toUpperCase() : '') || 'FILE';
  return {
    id: stableId('artifact', b.id || b.ts, a.path || a.name || format),
    kind: a.isImage ? 'image' : 'file',
    title: a.name || a.file || 'attachment',
    format,
    mime: a.type || '',
    size: Number(a.size || 0),
    path: a.path || '',
    url: a.url || '',
    summary: [format, a.type].filter(Boolean).join(' / '),
    sourceRefs: [sourceRef(b)],
  };
}

function parseStatusPath(line = '') {
  const trimmed = String(line || '').trim();
  const m = trimmed.match(/^(?:[MADRCU?!]{1,2}|[ MADRCU?!]{1,2})\s+(.+)$/);
  if (!m) return '';
  return m[1].replace(/^"|"$/g, '').trim();
}

function changedPathsFromStatus(text = '') {
  return unique(String(text || '').split(/\r?\n/).map(parseStatusPath));
}

function changedFilesFromNumstat(text = '') {
  return String(text || '').split(/\r?\n/).map((line) => {
    const parts = line.split('\t');
    if (parts.length < 3) return null;
    const path = parts.slice(2).join('\t').trim();
    if (!path) return null;
    const add = parts[0] === '-' ? null : Number(parts[0]);
    const del = parts[1] === '-' ? null : Number(parts[1]);
    return {
      path,
      additions: Number.isFinite(add) ? add : null,
      deletions: Number.isFinite(del) ? del : null,
      binary: add == null || del == null,
    };
  }).filter(Boolean);
}

function changedFilesFromStat(text = '') {
  return String(text || '').split(/\r?\n/).map((line) => {
    const m = line.match(/^\s*(.+?)\s+\|\s+(\d+)(?:\s+([+-]+))?/);
    if (!m) return null;
    return {
      path: m[1].trim(),
      lines: Number(m[2]) || 0,
      additions: (m[3] || '').split('').filter((c) => c === '+').length || null,
      deletions: (m[3] || '').split('').filter((c) => c === '-').length || null,
      binary: false,
    };
  }).filter(Boolean);
}

function patchesByFile(diff = '') {
  const files = new Map();
  let current = null;
  for (const line of String(diff || '').split(/\r?\n/)) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      const path = m[2] || m[1];
      current = { path, lines: [line] };
      files.set(path, current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return files;
}

function normalizeDiffBlock(b = {}) {
  const byPath = new Map();
  for (const row of [...changedFilesFromNumstat(b.stat), ...changedFilesFromStat(b.stat)]) {
    if (!row.path) continue;
    byPath.set(row.path, { ...byPath.get(row.path), ...row });
  }
  for (const path of changedPathsFromStatus(b.status)) {
    if (!byPath.has(path)) byPath.set(path, { path, additions: null, deletions: null, binary: false });
  }
  const patches = patchesByFile(b.diff);
  for (const [path] of patches) {
    if (!byPath.has(path)) byPath.set(path, { path, additions: null, deletions: null, binary: false });
  }
  const files = [...byPath.values()]
    .sort((a, c) => String(a.path).localeCompare(String(c.path)))
    .map((row) => {
      const patch = patches.get(row.path)?.lines.join('\n') || '';
      const patchLines = patch.split(/\r?\n/);
      return {
        id: stableId('artifact', b.id || b.ts, row.path),
        kind: 'code-change',
        title: row.path,
        path: row.path,
        format: 'DIFF',
        additions: row.additions,
        deletions: row.deletions,
        binary: Boolean(row.binary),
        summary: [
          row.additions != null ? `+${row.additions}` : null,
          row.deletions != null ? `-${row.deletions}` : null,
          row.binary ? 'binary' : null,
        ].filter(Boolean).join(' '),
        patchPreview: patchLines.length > PATCH_PREVIEW_LINES ? `${patchLines.slice(0, PATCH_PREVIEW_LINES).join('\n')}\n...` : patch,
        patchTruncated: patchLines.length > PATCH_PREVIEW_LINES,
        sourceRefs: [sourceRef(b)],
      };
    });
  return {
    id: stableId('change', b.id || b.ts, b.scope || 'workspace'),
    kind: 'change-set',
    title: b.title || 'Changes',
    summary: b.summary || '',
    scope: b.scope || 'workspace',
    project: b.project || '',
    root: b.root || '',
    statusText: b.status || '',
    statText: b.stat || '',
    diffPreview: b.diff || '',
    truncated: Boolean(b.truncated),
    error: b.error || '',
    files,
    sourceRefs: [sourceRef(b)],
  };
}

function normalizeTerminalBlock(b = {}) {
  const lines = String(b.text || '').split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim());
  const preview = nonEmpty.slice(-TERMINAL_PREVIEW_LINES).join('\n');
  return {
    id: stableId('terminal', b.id || b.ts, b.summary),
    kind: 'terminal-evidence',
    title: b.title || 'Terminal evidence',
    summary: b.summary || `${nonEmpty.length} terminal lines`,
    lines: nonEmpty.length,
    preview,
    text: b.text || '',
    truncated: Boolean(b.truncated) || nonEmpty.length > TERMINAL_PREVIEW_LINES,
    sourceRefs: [sourceRef(b)],
  };
}

function normalizeMessageBlock(b = {}) {
  return {
    id: stableId('message', b.id || b.ts, b.role),
    role: roleForAgui(b.role),
    aiosRole: b.role || 'agent',
    title: b.title || (b.role === 'user' ? 'Request' : 'Response'),
    summary: b.summary || compactText(b.text),
    text: b.text || '',
    attachments: attachmentsForBlock(b).map((a) => normalizeAttachment(a, b)),
    sourceRefs: [sourceRef(b)],
  };
}

function normalizeDecisionBlock(b = {}) {
  return {
    id: stableId('decision', b.id || b.ts, b.status),
    kind: 'decision',
    status: b.status || '',
    category: b.category || '',
    title: b.title || (b.status === 'pending' ? 'Needs input' : 'Decision'),
    summary: b.summary || compactText(b.ask || b.question || ''),
    ask: b.ask || b.question || '',
    response: b.response || '',
    sourceRefs: [sourceRef(b)],
  };
}

function normalizeActivityBlock(b = {}) {
  return {
    id: stableId('activity', b.id || b.ts, b.subtype || b.type),
    kind: b.subtype || b.type || 'event',
    title: b.title || b.subtype || 'Activity',
    summary: b.summary || '',
    payload: b.payload || null,
    sourceRefs: [sourceRef(b)],
  };
}

function emptyGroup(kind, firstBlock, index) {
  return {
    id: stableId('request', kind, firstBlock?.id || firstBlock?.ts || index),
    kind,
    title: kind === 'setup' ? 'Session setup' : 'Request',
    summary: '',
    status: kind === 'setup' ? 'setup' : 'completed',
    ts: firstBlock?.ts || 0,
    endTs: firstBlock?.ts || 0,
    request: null,
    responses: [],
    decisions: [],
    activity: [],
    artifacts: [],
    changes: [],
    terminal: [],
    sourceRefs: [],
    counts: {},
  };
}

function addSourceRefs(group, refs = []) {
  const seen = new Set(group.sourceRefs.map((r) => `${r.type}:${r.blockId}:${r.ts}`));
  for (const ref of refs) {
    const key = `${ref.type}:${ref.blockId}:${ref.ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    group.sourceRefs.push(ref);
  }
}

function applyBlockToGroup(group, b) {
  group.endTs = Math.max(tsValue(group.endTs), tsValue(b.ts));
  const refs = [sourceRef(b)];
  addSourceRefs(group, refs);

  if (b.type === 'message') {
    const msg = normalizeMessageBlock(b);
    if (b.role === 'user' && !group.request) {
      group.request = msg;
      group.title = compactText(msg.summary || msg.text || 'Request', 96);
      group.summary = compactText(msg.text || msg.summary, 220);
    } else {
      group.responses.push(msg);
      if (!group.summary && msg.summary) group.summary = compactText(msg.summary, 220);
    }
    group.artifacts.push(...msg.attachments);
    return;
  }
  if (b.type === 'decision') {
    group.decisions.push(normalizeDecisionBlock(b));
    if (b.status === 'pending') group.status = 'needs-input';
    if (b.summary) group.summary = compactText(b.summary, 220);
    return;
  }
  if (b.type === 'attachment') {
    group.artifacts.push(...attachmentsForBlock(b).map((a) => normalizeAttachment(a, b)));
    if (b.summary && !group.summary) group.summary = compactText(b.summary, 220);
    return;
  }
  if (b.type === 'diff') {
    const change = normalizeDiffBlock(b);
    group.changes.push(change);
    group.artifacts.push(...change.files);
    group.summary = compactText(change.summary || group.summary, 220);
    return;
  }
  if (b.type === 'terminal') {
    group.terminal.push(normalizeTerminalBlock(b));
    return;
  }
  group.activity.push(normalizeActivityBlock(b));
  if (!group.summary && b.summary) group.summary = compactText(b.summary, 220);
}

function finalizeGroups(groups, session = {}) {
  const latestRequestIndex = groups.findLastIndex((g) => g.kind === 'request');
  return groups.map((g, index) => {
    const pending = g.decisions.filter((d) => d.status === 'pending').length;
    const status = pending
      ? 'needs-input'
      : g.kind === 'setup'
        ? 'setup'
        : index === latestRequestIndex && session.status !== 'exited'
          ? 'active'
          : 'completed';
    const summary = g.summary || g.responses.at(-1)?.summary || g.activity.at(-1)?.summary || g.request?.summary || '';
    return {
      ...g,
      status,
      summary: compactText(summary, 260),
      endTs: g.endTs || g.ts,
      counts: {
        responses: g.responses.length,
        decisions: g.decisions.length,
        openDecisions: pending,
        activity: g.activity.length,
        artifacts: g.artifacts.length,
        changedFiles: g.artifacts.filter((a) => a.kind === 'code-change').length,
        changeSets: g.changes.length,
        terminal: g.terminal.length,
        sourceRefs: g.sourceRefs.length,
      },
    };
  });
}

export function buildAgentGroups(blocks = [], session = {}) {
  const groups = [];
  let current = null;
  const sorted = sortByTime(blocks);

  function pushCurrent() {
    if (current && current.sourceRefs.length) groups.push(current);
  }

  sorted.forEach((b, index) => {
    if (b.type === 'message' && b.role === 'user') {
      pushCurrent();
      current = emptyGroup('request', b, index);
      applyBlockToGroup(current, b);
      return;
    }
    if (!current) current = emptyGroup('setup', b, index);
    applyBlockToGroup(current, b);
  });
  pushCurrent();
  return finalizeGroups(groups, session);
}

function aguiTimestamp(ts) {
  const n = tsValue(ts);
  return n ? n : Date.now();
}

function baseEvent(type, group, source, extra = {}) {
  return {
    type,
    timestamp: aguiTimestamp(source?.ts || group?.ts),
    requestId: group?.id || null,
    sourceRef: sourceRef(source || {}),
    ...extra,
  };
}

function textEventsForMessage(group, msg, source, index) {
  const messageId = msg.id || stableId('message', group.id, index);
  const text = msg.text || msg.summary || '';
  return [
    baseEvent(EventType.TEXT_MESSAGE_START, group, source, {
      eventId: stableId('agui', messageId, 'start'),
      messageId,
      role: msg.role || 'assistant',
    }),
    baseEvent(EventType.TEXT_MESSAGE_CONTENT, group, source, {
      eventId: stableId('agui', messageId, 'content'),
      messageId,
      delta: text,
    }),
    baseEvent(EventType.TEXT_MESSAGE_END, group, source, {
      eventId: stableId('agui', messageId, 'end'),
      messageId,
    }),
  ];
}

function customEvent(name, group, source, value, suffix) {
  return baseEvent(EventType.CUSTOM, group, source, {
    eventId: stableId('agui', group?.id, name, suffix || source?.id || source?.ts),
    name,
    value,
  });
}

function toolEvents(group, source, toolName, content, suffix) {
  const toolCallId = stableId('tool', group.id, toolName, suffix || source?.id || source?.ts);
  const messageId = stableId('tool-message', group.id, toolName, suffix || source?.id || source?.ts);
  return [
    baseEvent(EventType.TOOL_CALL_START, group, source, {
      eventId: stableId('agui', toolCallId, 'start'),
      toolCallId,
      toolCallName: toolName,
    }),
    baseEvent(EventType.TOOL_CALL_RESULT, group, source, {
      eventId: stableId('agui', toolCallId, 'result'),
      messageId,
      toolCallId,
      content,
    }),
    baseEvent(EventType.TOOL_CALL_END, group, source, {
      eventId: stableId('agui', toolCallId, 'end'),
      toolCallId,
    }),
  ];
}

export function timelineToAguiEvents({ session = {}, timeline = {}, groups = buildAgentGroups(timeline.blocks || [], session) } = {}) {
  const threadId = String(session.id || 'session');
  const runId = stableId('run', threadId, timeline.generatedAt || '', groups.at(-1)?.endTs || '');
  const events = [
    {
      type: EventType.RUN_STARTED,
      eventId: stableId('agui', runId, 'run-start'),
      timestamp: aguiTimestamp(session.started_at || timeline.generatedAt),
      threadId,
      runId,
    },
    {
      type: EventType.STATE_SNAPSHOT,
      eventId: stableId('agui', runId, 'state'),
      timestamp: aguiTimestamp(timeline.generatedAt),
      snapshot: {
        schemaVersion: SCHEMA_VERSION,
        session: {
          id: session.id || '',
          tool: session.tool || '',
          model: session.model || '',
          status: session.status || '',
          title: session.title || '',
        },
        stats: timeline.stats || {},
        groups: groups.map((g) => ({
          id: g.id,
          kind: g.kind,
          title: g.title,
          status: g.status,
          counts: g.counts,
        })),
      },
    },
  ];

  const messages = [];
  for (const b of sortByTime(timeline.blocks || [])) {
    if (b.type !== 'message') continue;
    const msg = normalizeMessageBlock(b);
    messages.push({ id: msg.id, role: msg.role, content: msg.text || msg.summary || '' });
  }
  events.push({
    type: EventType.MESSAGES_SNAPSHOT,
    eventId: stableId('agui', runId, 'messages'),
    timestamp: aguiTimestamp(timeline.generatedAt),
    messages,
  });

  groups.forEach((group, groupIndex) => {
    const groupSource = group.sourceRefs[0] || {};
    events.push(baseEvent(EventType.STEP_STARTED, group, groupSource, {
      eventId: stableId('agui', group.id, 'step-start'),
      stepName: group.title || `Request ${groupIndex + 1}`,
    }));
    if (group.request) events.push(...textEventsForMessage(group, group.request, group.request.sourceRefs[0], 'request'));
    group.responses.forEach((msg, i) => events.push(...textEventsForMessage(group, msg, msg.sourceRefs[0], `response-${i}`)));
    group.decisions.forEach((decision, i) => {
      events.push(customEvent('aios.decision', group, decision.sourceRefs[0], decision, i));
    });
    group.activity.forEach((activity, i) => {
      events.push(customEvent('aios.activity', group, activity.sourceRefs[0], activity, i));
    });
    group.artifacts.filter((a) => a.kind !== 'code-change').forEach((artifact, i) => {
      events.push(customEvent('aios.artifact', group, artifact.sourceRefs[0], artifact, i));
    });
    group.changes.forEach((change, i) => {
      events.push(...toolEvents(group, change.sourceRefs[0], 'git.diff', JSON.stringify({
        id: change.id,
        summary: change.summary,
        scope: change.scope,
        files: change.files.map((f) => ({
          path: f.path,
          additions: f.additions,
          deletions: f.deletions,
          binary: f.binary,
        })),
      }, null, 2), i));
    });
    group.terminal.forEach((terminal, i) => {
      events.push(...toolEvents(group, terminal.sourceRefs[0], 'terminal.tail', terminal.preview || terminal.text || '', i));
    });
    if (group.status !== 'active') {
      events.push(baseEvent(EventType.STEP_FINISHED, group, groupSource, {
        eventId: stableId('agui', group.id, 'step-finish'),
        stepName: group.title || `Request ${groupIndex + 1}`,
      }));
    }
  });

  if (session.status === 'exited') {
    events.push({
      type: EventType.RUN_FINISHED,
      eventId: stableId('agui', runId, 'run-finish'),
      timestamp: aguiTimestamp(timeline.generatedAt),
      threadId,
      runId,
    });
  }
  return events.map(validateAguiEvent);
}

export function validateAguiEvent(event) {
  const schema = EVENT_SCHEMAS[event?.type];
  if (!schema) throw new Error(`Unsupported AG-UI event type: ${event?.type || '(missing)'}`);
  const parsed = schema.safeParse(event);
  if (!parsed.success) {
    const issue = parsed.error.issues?.[0];
    throw new Error(`Invalid AG-UI event ${event.type}: ${issue?.path?.join('.') || 'event'} ${issue?.message || parsed.error.message}`);
  }
  return parsed.data;
}

export function validateAguiEvents(events = []) {
  return events.map(validateAguiEvent);
}

export function buildAgentTimelinePayload({ session = {}, timeline = {} } = {}) {
  const groups = buildAgentGroups(timeline.blocks || [], session);
  const events = timelineToAguiEvents({ session, timeline, groups });
  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: timeline.generatedAt,
    session,
    stats: timeline.stats || {},
    agui: {
      threadId: String(session.id || 'session'),
      runId: stableId('run', session.id || 'session', timeline.generatedAt || '', groups.at(-1)?.endTs || ''),
      eventCount: events.length,
      eventTypes: unique(events.map((event) => event.type)),
    },
    groups,
    events,
  };
}
