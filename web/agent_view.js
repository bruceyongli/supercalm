import { escapeHtml } from './common.js';

const PREF_PREFIX = 'aios.session.agentView';
const TERMINAL_PREVIEW_LINES = 12;
const AGENT_API_TIMEOUT_MS = 20000;
const PATCH_PREVIEW_LINES = 120;

async function agentApi(path, { signal } = {}) {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => ctrl.abort(), AGENT_API_TIMEOUT_MS);
  try {
    const r = await fetch(path, { signal: ctrl.signal });
    const ct = r.headers.get('content-type') || '';
    const body = ct.includes('json') ? await r.json().catch(() => ({})) : await r.text();
    if (!r.ok) throw new Error((body && body.error) || r.status);
    return body;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('Agent View took too long to load. Retry when the session is less busy.');
    throw e;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function compactText(text, max = 180) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, Math.max(0, max - 3)).trimEnd()}...` : s;
}

function timeLabel(ts) {
  if (!ts) return '';
  const t = Date.parse(ts) || Number(ts);
  if (!Number.isFinite(t)) return String(ts);
  return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtBytes(v) {
  const n = Number(v || 0);
  if (!n) return '';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function hashText(value) {
  let h = 2166136261;
  const s = String(value || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function stableId(prefix, ...parts) {
  const raw = parts.map((p) => String(p ?? '')).filter(Boolean).join(':');
  const safe = raw.replace(/[^A-Za-z0-9_.:-]/g, '-').replace(/-+/g, '-').slice(0, 80);
  return `${prefix}:${safe || hashText(raw)}:${hashText(raw)}`;
}

function tsValue(ts) {
  const t = Date.parse(ts) || Number(ts);
  return Number.isFinite(t) ? t : 0;
}

function sortByTime(items = []) {
  return [...items].sort((a, b) => tsValue(a.ts) - tsValue(b.ts) || String(a.id || '').localeCompare(String(b.id || '')));
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
  const files = [...byPath.values()].sort((a, c) => String(a.path).localeCompare(String(c.path))).map((row) => {
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
  return {
    id: stableId('terminal', b.id || b.ts, b.summary),
    kind: 'terminal-evidence',
    title: b.title || 'Terminal evidence',
    summary: b.summary || `${nonEmpty.length} terminal lines`,
    lines: nonEmpty.length,
    preview: nonEmpty.slice(-TERMINAL_PREVIEW_LINES).join('\n'),
    text: b.text || '',
    truncated: Boolean(b.truncated) || nonEmpty.length > TERMINAL_PREVIEW_LINES,
    sourceRefs: [sourceRef(b)],
  };
}

function roleForMessage(role) {
  if (role === 'user') return 'user';
  if (role === 'system' || role === 'developer') return role;
  return 'assistant';
}

function normalizeMessageBlock(b = {}) {
  return {
    id: stableId('message', b.id || b.ts, b.role),
    role: roleForMessage(b.role),
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
  const seen = new Set((group.sourceRefs || []).map((r) => `${r.type}:${r.blockId}:${r.ts}`));
  for (const ref of refs) {
    const key = `${ref.type}:${ref.blockId}:${ref.ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    group.sourceRefs.push(ref);
  }
}

function applyBlockToGroup(group, b = {}) {
  group.endTs = Math.max(tsValue(group.endTs), tsValue(b.ts));
  addSourceRefs(group, [sourceRef(b)]);

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

function buildAgentGroupsFromTimeline(blocks = [], session = {}) {
  const groups = [];
  let current = null;
  const pushCurrent = () => {
    if (current && current.sourceRefs.length) groups.push(current);
  };
  sortByTime(blocks).forEach((b, index) => {
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

function timelineToAgentPayload(timeline = {}, fallbackError = '') {
  const session = timeline.session || {};
  const groups = buildAgentGroupsFromTimeline(timeline.blocks || [], session);
  return {
    ok: true,
    schemaVersion: 1,
    generatedAt: timeline.generatedAt,
    session,
    stats: timeline.stats || {},
    agui: {
      threadId: String(session.id || 'session'),
      runId: stableId('run', session.id || 'session', timeline.generatedAt || '', groups.at(-1)?.endTs || ''),
      eventCount: 0,
      eventTypes: [],
      fallback: 'timeline',
      fallbackError,
    },
    groups,
    events: [],
    fallback: { source: 'timeline', error: fallbackError },
  };
}

async function loadAgentPayload(sessionId, signal) {
  const encoded = encodeURIComponent(sessionId);
  try {
    return await agentApi(`api/session/${encoded}/agui`, { signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    const timeline = await agentApi(`api/session/${encoded}/timeline`, { signal });
    return timelineToAgentPayload(timeline, e.message || String(e));
  }
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${Number(n) === 1 ? one : many}`;
}

function statusLabel(status) {
  if (status === 'needs-input') return 'Needs input';
  if (status === 'active') return 'Active';
  if (status === 'setup') return 'Setup';
  return 'Done';
}

function statusClass(status) {
  return String(status || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function pre(text, cls = 'agent-pre') {
  return `<pre class="${cls}">${escapeHtml(text || '')}</pre>`;
}

function detail(key, label, body, open = false, preview = '') {
  if (!body) return '';
  return `
    <details class="agent-section" data-agent-section-key="${escapeHtml(key)}" ${open ? 'open' : ''}>
      <summary>
        <span>${escapeHtml(label)}</span>
        ${preview ? `<em>${escapeHtml(preview)}</em>` : ''}
      </summary>
      <div class="agent-section-body">${body}</div>
    </details>`;
}

function artifactIcon(a = {}) {
  const label = escapeHtml((a.format || a.kind || 'FILE').slice(0, 8).toUpperCase());
  if (a.kind === 'image' && a.url) {
    return `<a class="agent-artifact-thumb image" href="${escapeHtml(a.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(a.url)}" alt="${escapeHtml(a.title || 'image')}" loading="lazy" /></a>`;
  }
  return `<span class="agent-artifact-thumb">${label}</span>`;
}

function renderArtifact(a = {}) {
  const meta = [
    a.kind === 'code-change' ? 'change' : a.kind,
    a.format,
    fmtBytes(a.size),
    a.summary,
  ].filter(Boolean).join(' / ');
  const title = a.url
    ? `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.title || a.path || 'artifact')}</a>`
    : `<span>${escapeHtml(a.title || a.path || 'artifact')}</span>`;
  return `
    <article class="agent-artifact ${escapeHtml(a.kind || '')}">
      ${artifactIcon(a)}
      <div>
        <b>${title}</b>
        <p>${escapeHtml(meta || a.path || '')}</p>
      </div>
    </article>`;
}

function diffLineClass(line) {
  if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) return 'file';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return '';
}

function renderPatch(text = '') {
  const lines = String(text || '').split(/\r?\n/);
  if (!lines.some((line) => line.trim())) return '';
  return `<pre class="agent-diff">${lines.map((line) => `<span class="diff-line ${diffLineClass(line)}">${escapeHtml(line || ' ')}</span>`).join('')}</pre>`;
}

function renderChangeFile(file = {}, groupId = '') {
  const bits = [
    file.additions != null ? `+${file.additions}` : null,
    file.deletions != null ? `-${file.deletions}` : null,
    file.binary ? 'binary' : null,
  ].filter(Boolean).join(' ');
  const patch = file.patchPreview ? detail(`${groupId}:patch:${file.id}`, 'Patch', renderPatch(file.patchPreview), false, file.patchTruncated ? 'truncated' : '') : '';
  return `
    <div class="agent-change-file">
      <div class="agent-change-head">
        <code>${escapeHtml(file.path || file.title)}</code>
        ${bits ? `<span>${escapeHtml(bits)}</span>` : ''}
      </div>
      ${patch}
    </div>`;
}

function renderChanges(changes = [], groupId = '') {
  return changes.map((change, index) => {
    const files = change.files || [];
    const preview = files.slice(0, 4).map((f) => f.path || f.title).join(', ');
    const label = files.length ? `${plural(files.length, 'file')} changed` : (change.scope === 'workspace' ? 'Changes' : change.title || 'Changes');
    const body = `
      ${change.summary ? `<p class="agent-section-summary">${escapeHtml(change.summary)}</p>` : ''}
      ${change.error ? `<p class="agent-warning">${escapeHtml(change.error)}</p>` : ''}
      <div class="agent-change-list">${files.map((file) => renderChangeFile(file, groupId)).join('')}</div>
      ${change.statText ? detail(`${groupId}:change-stat:${index}`, 'Stat text', pre(change.statText), false) : ''}
      ${change.statusText ? detail(`${groupId}:change-status:${index}`, 'Changed paths', pre(change.statusText), false) : ''}
      ${change.diffPreview ? detail(`${groupId}:change-diff:${index}`, change.truncated ? 'Diff preview' : 'Diff', renderPatch(change.diffPreview), false, change.truncated ? 'truncated' : '') : ''}`;
    return detail(`${groupId}:change:${change.id || index}`, label, body, false, preview || change.summary || '');
  }).join('');
}

function renderTerminal(items = [], groupId = '') {
  return items.map((item, index) => {
    const lines = String(item.text || '').split(/\r?\n/).filter((line) => line.trim());
    const preview = item.preview || lines.slice(-TERMINAL_PREVIEW_LINES).join('\n');
    const body = `
      ${item.summary ? `<p class="agent-section-summary">${escapeHtml(item.summary)}</p>` : ''}
      ${pre(preview)}
      ${item.text && item.text !== preview ? detail(`${groupId}:terminal-full:${index}`, 'Full terminal output', pre(item.text), false, plural(lines.length, 'line')) : ''}`;
    return detail(`${groupId}:terminal:${item.id || index}`, item.title || 'Terminal evidence', body, false, item.truncated ? 'trimmed' : plural(item.lines || lines.length, 'line'));
  }).join('');
}

function renderDecisions(decisions = [], groupId = '') {
  const rows = decisions.map((d) => `
    <article class="agent-decision ${escapeHtml(statusClass(d.status))}">
      <div>
        <b>${escapeHtml(d.status === 'pending' ? 'Needs input' : d.category || d.title || 'Decision')}</b>
        ${d.summary ? `<p>${escapeHtml(d.summary)}</p>` : ''}
      </div>
      ${d.response ? `<p class="agent-user-response">You: ${escapeHtml(d.response)}</p>` : ''}
      ${d.ask ? detail(`${groupId}:decision-ask:${d.id}`, 'Full ask', pre(d.ask), d.status === 'pending') : ''}
    </article>`).join('');
  return detail(`${groupId}:decisions`, `${plural(decisions.length, 'decision')}`, rows, decisions.some((d) => d.status === 'pending'), decisions.some((d) => d.status === 'pending') ? 'open' : 'answered');
}

function renderActivity(items = [], groupId = '') {
  const rows = items.map((item) => `
    <article class="agent-activity-item">
      <div>
        <b>${escapeHtml(item.title || item.kind || 'Activity')}</b>
        ${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ''}
      </div>
      ${item.payload ? detail(`${groupId}:activity-payload:${item.id}`, 'Payload', pre(JSON.stringify(item.payload, null, 2)), false) : ''}
    </article>`).join('');
  return detail(`${groupId}:activity`, `${plural(items.length, 'activity item')}`, rows, false, compactText(items.at(-1)?.summary || items.at(-1)?.title, 80));
}

function renderDebugDetails(events = [], group = {}) {
  const related = events.filter((event) => event.requestId === group.id);
  const parts = [
    related.length ? `<div class="agent-debug-group"><b>AG-UI events</b>${related.map((event) => `
      <div class="agent-event-row">
        <span>${escapeHtml(event.type)}</span>
        <code>${escapeHtml(event.eventId || event.messageId || event.toolCallId || '')}</code>
      </div>`).join('')}</div>` : '',
    group.sourceRefs?.length ? `<div class="agent-debug-group"><b>Source blocks</b>${(group.sourceRefs || []).map((ref) => `
      <div class="agent-event-row">
        <span>${escapeHtml([ref.type, ref.subtype, ref.role].filter(Boolean).join(' / ') || 'source')}</span>
        <code>${escapeHtml(ref.blockId || '')}</code>
      </div>`).join('')}</div>` : '',
  ].filter(Boolean).join('');
  if (!parts) return '';
  const preview = [
    related.length ? `${related.length} AG-UI` : '',
    group.sourceRefs?.length ? `${group.sourceRefs.length} source` : '',
  ].filter(Boolean).join(' / ');
  return detail(`${group.id}:debug`, 'Debug details', parts, false, preview);
}

function groupChips(group = {}) {
  const counts = group.counts || {};
  const chips = [];
  if (counts.changedFiles) chips.push(`${counts.changedFiles} files`);
  if (counts.changeSets) chips.push(`${counts.changeSets} changes`);
  if (counts.terminal) chips.push(`${counts.terminal} terminal`);
  if (counts.decisions) chips.push(`${counts.decisions} decisions`);
  if (counts.artifacts) chips.push(`${counts.artifacts} artifacts`);
  if (counts.activity) chips.push(`${counts.activity} activity`);
  return chips.slice(0, 5);
}

function renderGroup(group = {}, index, groups, state, data) {
  const defaultOpen = group.status === 'active' || group.status === 'needs-input' || index === groups.findLastIndex((g) => g.kind === 'request');
  const manuallyOpen = state.openGroups.has(group.id);
  const manuallyClosed = state.closedGroups.has(group.id);
  const open = manuallyOpen || (!manuallyClosed && defaultOpen);
  const selected = state.selectedRequestId === group.id;
  const requestText = group.request?.text || group.request?.summary || '';
  const artifacts = (group.artifacts || []).filter((a) => a.kind !== 'code-change');
  const sections = [
    group.request ? detail(`${group.id}:request`, 'Request text', pre(requestText), false, compactText(requestText, 80)) : '',
    group.responses?.length ? detail(`${group.id}:responses`, `${plural(group.responses.length, 'response')}`, group.responses.map((m) => pre(m.text || m.summary)).join(''), false, compactText(group.responses.at(-1)?.summary, 80)) : '',
    group.decisions?.length ? renderDecisions(group.decisions, group.id) : '',
    artifacts.length ? detail(`${group.id}:artifacts`, `${plural(artifacts.length, 'artifact')}`, `<div class="agent-artifact-grid">${artifacts.map(renderArtifact).join('')}</div>`, false, artifacts.slice(0, 3).map((a) => a.format || a.kind).join(', ')) : '',
    group.changes?.length ? renderChanges(group.changes, group.id) : '',
    group.terminal?.length ? renderTerminal(group.terminal, group.id) : '',
    group.activity?.length ? renderActivity(group.activity, group.id) : '',
    renderDebugDetails(data.events || [], group),
  ].filter(Boolean).join('');
  const chips = groupChips(group);
  return `
    <details class="agent-request ${escapeHtml(statusClass(group.status))} ${selected ? 'selected' : ''}" data-agent-group-id="${escapeHtml(group.id)}" ${open ? 'open' : ''}>
      <summary>
        <span class="agent-request-status">${escapeHtml(statusLabel(group.status))}</span>
        <span class="agent-request-main">
          <span class="agent-request-title">${escapeHtml(group.title || 'Request')}</span>
          ${group.summary ? `<span class="agent-request-summary">${escapeHtml(group.summary)}</span>` : ''}
          ${chips.length ? `<span class="agent-chips">${chips.map((chip) => `<span>${escapeHtml(chip)}</span>`).join('')}</span>` : ''}
        </span>
        <span class="agent-request-time">${escapeHtml(timeLabel(group.ts))}</span>
      </summary>
      <div class="agent-request-body">
        ${sections || '<div class="agent-muted">No request details recorded yet.</div>'}
      </div>
    </details>`;
}

function renderOverview(data = {}) {
  const groups = data.groups || [];
  const requestGroups = groups.filter((g) => g.kind === 'request');
  const active = groups.find((g) => g.status === 'active') || requestGroups.at(-1) || groups.at(-1);
  const openAsks = groups.reduce((n, g) => n + Number(g.counts?.openDecisions || 0), 0);
  const artifactCount = groups.reduce((n, g) => n + Number(g.counts?.artifacts || 0), 0);
  const changeSets = groups.reduce((n, g) => n + Number(g.counts?.changeSets || 0), 0);
  const session = data.session || {};
  const model = [session.toolLabel || session.tool, session.modelLabel || session.model].filter(Boolean).join(' / ');
  const pills = [
    [requestGroups.length, 'requests'],
    [artifactCount, 'artifacts'],
    [changeSets, 'change sets'],
    openAsks ? [openAsks, 'open asks'] : null,
  ].filter(Boolean);
  return `
    <section class="agent-overview">
      <div>
        <b>${escapeHtml(session.title || 'Agent View')}</b>
        <p>${escapeHtml(compactText(active?.summary || active?.title || 'Request-level timeline', 220))}</p>
        <span>${escapeHtml(model)}${data.generatedAt ? ` / Updated ${escapeHtml(timeLabel(data.generatedAt))}` : ''}</span>
      </div>
      <div class="agent-overview-pills">
        ${pills.map(([value, label]) => `<span><b>${escapeHtml(value)}</b> ${escapeHtml(label)}</span>`).join('')}
      </div>
    </section>`;
}

function render(data = {}, state) {
  const groups = data.groups || [];
  if (!groups.length) {
    return '<div class="timeline-empty">No Agent View events yet.</div>';
  }
  return `
    ${renderOverview(data)}
    <div class="agent-request-list">
      ${groups.map((group, index) => renderGroup(group, index, groups, state, data)).join('')}
    </div>
    <button class="jump-latest agent-jump-latest" type="button" hidden>Latest</button>`;
}

export function createAgentView({ root, sessionId, onData, onSelectRequest } = {}) {
  const storageKey = `${PREF_PREFIX}.${sessionId}`;
  const state = {
    data: null,
    loaded: false,
    openGroups: new Set(),
    closedGroups: new Set(),
    openSections: new Set(),
    selectedRequestId: '',
    scrollTop: 0,
  };

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    state.selectedRequestId = saved.selectedRequestId || '';
    state.scrollTop = Number(saved.scrollTop || 0);
    state.openGroups = new Set(saved.openGroups || []);
    state.closedGroups = new Set(saved.closedGroups || []);
    state.openSections = new Set(saved.openSections || []);
  } catch {}

  function saveState() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        selectedRequestId: state.selectedRequestId,
        scrollTop: root.scrollTop,
        openGroups: [...state.openGroups],
        closedGroups: [...state.closedGroups],
        openSections: [...state.openSections],
      }));
    } catch {}
  }

  function captureScroll() {
    state.scrollTop = root.scrollTop;
    saveState();
  }

  function updateJumpButton() {
    const btn = root.querySelector('.agent-jump-latest');
    if (!btn) return;
    const bottomDistance = root.scrollHeight - root.clientHeight - root.scrollTop;
    btn.hidden = bottomDistance <= Math.max(260, root.clientHeight * 1.5);
  }

  function selectGroup(groupId) {
    const group = (state.data?.groups || []).find((g) => g.id === groupId);
    if (!group) return;
    state.selectedRequestId = group.id;
    saveState();
    onSelectRequest?.(group, state.data);
    root.querySelectorAll('.agent-request').forEach((el) => {
      el.classList.toggle('selected', el.dataset.agentGroupId === group.id);
    });
  }

  function restoreAfterRender({ preserveScroll = true } = {}) {
    root.querySelectorAll('.agent-section[data-agent-section-key]').forEach((el) => {
      el.open = state.openSections.has(el.dataset.agentSectionKey);
    });
    if (state.selectedRequestId) {
      root.querySelectorAll('.agent-request').forEach((el) => {
        el.classList.toggle('selected', el.dataset.agentGroupId === state.selectedRequestId);
      });
    }
    requestAnimationFrame(() => {
      if (preserveScroll) root.scrollTop = state.scrollTop;
      updateJumpButton();
    });
  }

  function renderData(data, { firstLoad = false } = {}) {
    const groups = data.groups || [];
    if (!state.selectedRequestId) {
      state.selectedRequestId = groups.findLast?.((g) => g.kind === 'request')?.id || groups.at(-1)?.id || '';
    }
    state.data = data;
    onData?.(data);
    root.innerHTML = render(data, state);
    restoreAfterRender({ preserveScroll: !firstLoad });
    if (firstLoad) {
      requestAnimationFrame(() => {
        const selected = state.selectedRequestId
          ? [...root.querySelectorAll('.agent-request[data-agent-group-id]')].find((el) => el.dataset.agentGroupId === state.selectedRequestId)
          : null;
        const target = selected || root.querySelector('.agent-request:last-child');
        if (target) root.scrollTop = Math.max(0, target.offsetTop - 12);
        updateJumpButton();
      });
    }
  }

  root.addEventListener('toggle', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLDetailsElement)) return;
    if (target.classList.contains('agent-request')) {
      const id = target.dataset.agentGroupId;
      if (!id) return;
      if (target.open) {
        state.openGroups.add(id);
        state.closedGroups.delete(id);
        selectGroup(id);
      } else {
        state.closedGroups.add(id);
        state.openGroups.delete(id);
      }
      saveState();
      return;
    }
    if (target.classList.contains('agent-section')) {
      const key = target.dataset.agentSectionKey;
      if (!key) return;
      if (target.open) state.openSections.add(key);
      else state.openSections.delete(key);
      saveState();
    }
  }, true);

  root.addEventListener('click', (e) => {
    const retry = e.target.closest?.('.agent-retry');
    if (retry) {
      e.preventDefault();
      retry.disabled = true;
      retry.textContent = 'Retrying...';
      api.load({ refresh: true });
      return;
    }
    const jump = e.target.closest?.('.agent-jump-latest');
    if (jump) {
      root.scrollTop = root.scrollHeight;
      captureScroll();
      updateJumpButton();
      return;
    }
    const groupEl = e.target.closest?.('.agent-request[data-agent-group-id]');
    if (groupEl) selectGroup(groupEl.dataset.agentGroupId);
  });

  root.addEventListener('scroll', () => {
    captureScroll();
    updateJumpButton();
  }, { passive: true });

  const api = {
    async load({ refresh = false, signal } = {}) {
      const firstLoad = !state.loaded;
      if (firstLoad) root.innerHTML = '<div class="timeline-empty">Loading Agent View...</div>';
      try {
        const data = await loadAgentPayload(sessionId, signal);
        if (signal?.aborted) return;
        state.loaded = true;
        renderData(data, { firstLoad: firstLoad && !refresh });
      } catch (e) {
        if (signal?.aborted) return;
        root.innerHTML = `
          <div class="timeline-empty agent-error">
            <span>Failed to load Agent View: ${escapeHtml(e.message || String(e))}</span>
            <button class="btn ghost sm agent-retry" type="button">Retry</button>
          </div>`;
      }
    },
    get data() {
      return state.data;
    },
  };
  return api;
}
