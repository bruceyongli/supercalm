// Evidence → Rule: a focused, operator-facing exception loop.
//
// The inspector deliberately returns a small failing-step bundle, not the supervisor's full prompt or
// an IDE-sized log dump. Teach writes an explicit project standard; retry sends that approved rule to
// the current agent, while future launches receive it automatically from sessions.js.
import { route, json, readJson } from './server.js';
import { db, getSession, getProject, addEvent } from './store.js';
import { sessionContext } from './agents/evidence.js';
import { storyFor } from './story_api.js';
import { getContext } from './context_doc.js';
import {
  addStandard,
  getStandard,
  listStandards,
  listStandardsForSession,
  noteStandardsUsed,
  retireStandard,
} from './agents/supervisor/project_memory.js';
import { deliverReply } from './sessions.js';
import { bus } from './bus.js';

const clip = (value, max = 1200) => {
  const text = String(value || '').replace(/\r/g, '').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
};

function eventView(event) {
  if (!event) return null;
  return {
    kind: event.kind || 'note',
    ts: Number(event.ts) || 0,
    title: clip(event.title || event.kind || 'Event', 180),
    body: clip(event.body || event.text || '', 2200),
    meta: clip(event.meta || '', 240),
    exitCode: event.exitCode ?? null,
    chips: (event.chips || []).slice(0, 12).map((chip) => clip(chip, 160)),
    steps: (event.steps || []).slice(0, 12).map((step) => ({
      human: clip(step.human || '', 240),
      cmd: clip(step.cmd || '', 600),
    })),
  };
}

const DIAGNOSTIC_KINDS = new Set(['fail', 'ask', 'check']);

function focusIndex(events, requestedTs) {
  if (!events.length) return -1;
  if (requestedTs) {
    let best = 0;
    for (let i = 1; i < events.length; i++) {
      if (Math.abs(Number(events[i].ts || 0) - requestedTs) < Math.abs(Number(events[best].ts || 0) - requestedTs)) best = i;
    }
    if (DIAGNOSTIC_KINDS.has(events[best]?.kind)) return best;
    // Result/report cards already contain their own prose. When an old deep link points at one, walk
    // backward to the check, decision, or exception that produced it instead of echoing the report.
    for (let i = best - 1; i >= 0; i--) {
      if (DIAGNOSTIC_KINDS.has(events[i]?.kind)) return i;
    }
  }
  // Prefer the newest real exception/decision. A successful check is useful only when no failure or
  // unanswered decision exists in the loaded window.
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.kind === 'fail' || events[i]?.kind === 'ask') return i;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.kind === 'check') return i;
  }
  return events.length - 1;
}

function firstDiffHunk(diff) {
  const lines = String(diff || '').split('\n');
  if (!lines.length) return '';
  let start = lines.findIndex((line) => /^diff --git /.test(line));
  if (start < 0) start = 0;
  let hunk = lines.findIndex((line, index) => index >= start && /^@@ /.test(line));
  if (hunk < 0) hunk = start;
  const header = lines.slice(start, hunk);
  const body = lines.slice(hunk, hunk + 70);
  return clip([...header, ...body].join('\n'), 9000);
}

function latestReview(sessionId) {
  try {
    const row = db.prepare(`SELECT ts, kind, verdict, score, assessment, message, raw
      FROM supervisor_reviews WHERE session_id = ? ORDER BY ts DESC LIMIT 1`).get(sessionId);
    if (!row) return null;
    let parsed = null;
    try { parsed = JSON.parse(row.raw || ''); } catch {}
    return {
      ts: row.ts,
      kind: row.kind,
      verdict: row.verdict,
      score: row.score,
      assessment: clip(row.assessment, 1600),
      message: clip(row.message, 1200),
      unmet: Array.isArray(parsed?.unmet) ? parsed.unmet.slice(0, 8).map((item) => clip(item, 500)) : [],
    };
  } catch {
    return null;
  }
}

function suggestedRule(focus, review) {
  const unmet = review?.unmet?.[0] || '';
  const issue = clip(unmet || focus?.body || focus?.title || 'the relevant verification is incomplete', 180)
    .replace(/\s+/g, ' ')
    .replace(/^[-–—:\s]+|[-–—:\s]+$/g, '');
  return `When a verification step fails in this project, correct the underlying issue and rerun that exact check. For this failure — ${issue} — do not report completion until the check passes and its actual result is recorded.`;
}

function relevantOutput(terminal) {
  const lines = String(terminal || '').replace(/\r/g, '').split('\n').filter((line) => line.trim());
  return clip(lines.slice(-36).join('\n'), 4200);
}

function diagnosisFor(focus, review, commandSteps) {
  if (!focus) return {
    happened: 'No exception or decision was found in the recent work.',
    stopped: 'The session may only have a completed report; there is nothing useful to diagnose here.',
    next: 'Return to Story unless a new failed check or question appears.',
  };
  const command = commandSteps.find((step) => step.cmd)?.cmd || '';
  const unmet = review?.unmet?.filter(Boolean) || [];
  const exit = focus.exitCode != null ? `The recorded command exited with code ${focus.exitCode}.` : '';
  const stopped = unmet[0]
    || review?.assessment
    || exit
    || (focus.kind === 'ask'
      ? 'The agent needs an operator decision before it can choose the next branch.'
      : focus.kind === 'fail'
        ? 'A required verification failed, so the agent cannot honestly mark the work complete.'
      : 'The available result does not yet prove that the intended verification passed.');
  const next = command
    ? `Correct the underlying issue, then rerun: ${command}`
    : focus.kind === 'ask'
      ? 'Answer the decision, then let the agent continue and verify the resulting path.'
      : 'Correct the underlying issue, rerun the failed verification, and record the passing result.';
  return {
    happened: clip(focus.body || focus.title, 520),
    stopped: clip(stopped, 520),
    next: clip(next, 720),
    unmet: unmet.slice(0, 5).map((item) => clip(item, 420)),
  };
}

route('GET', '/api/session/:id/evidence', async (req, res, { id: sessionId }, url) => {
  const session = getSession(sessionId);
  if (!session) return json(res, 404, { error: 'no such session' });
  const project = session.project_id ? getProject(session.project_id) : null;
  const requestedTs = Number(url?.searchParams?.get('focus_ts')) || 0;
  try {
    const [context, story] = await Promise.all([
      sessionContext(session, { terminalMax: 8000, includeDiff: true }).catch(() => null),
      storyFor(sessionId, { rounds: 8, full: false }).catch(() => ({ events: [] })),
    ]);
    const events = story?.events || [];
    const index = focusIndex(events, requestedTs);
    const focus = eventView(events[index]);
    // If a fail row itself has no command, pair it with the nearest preceding command cluster.
    const commandEvent = focus?.steps?.length
      ? focus
      : [...events.slice(Math.max(0, index - 4), Math.max(0, index))].reverse().map(eventView).find((event) => event?.steps?.length) || null;
    const timeline = events.slice(Math.max(0, index - 3), Math.min(events.length, index + 4)).map(eventView);
    const review = latestReview(sessionId);
    const standards = project
      ? listStandardsForSession(project.id, sessionId).map((rule) => ({
          id: rule.id,
          text: rule.text,
          sourceRef: rule.source_ref,
          sourceSession: rule.session_id,
          createdAt: rule.created_at,
          reuseCount: Number(rule.reuse_count) || 0,
          lastUsedAt: rule.last_used_at,
          usedInThisRun: !!rule.used_in_this_run,
        }))
      : [];
    const projectContext = project ? getContext(project.id) : null;
    const git = context?.git || null;
    return json(res, 200, {
      ok: true,
      session: context?.session || {
        id: session.id, title: session.title, status: session.status, model: session.model, tool: session.tool,
      },
      project: project ? { id: project.id, name: project.name } : null,
      focus,
      focusIndex: index,
      commandSteps: commandEvent?.steps || [],
      diagnosis: diagnosisFor(focus, review, commandEvent?.steps || []),
      timeline,
      review,
      evidence: {
        git: git ? {
          status: clip(git.status, 3000),
          stat: clip(git.stat || git.committed_stat, 3000),
          commits: clip(git.commits_since_baseline, 2400),
          diffHunk: firstDiffHunk(git.diff || git.committed_diff),
          touchedTests: git.touched_test_files || [],
        } : null,
        terminal: relevantOutput(context?.terminal_tail),
      },
      guidance: {
        context: projectContext?.doc ? {
          text: clip(projectContext.doc, 2400),
          enabled: !!projectContext.enabled,
          source: projectContext.source || '',
        } : null,
        standards,
      },
      suggestedRule: suggestedRule(focus, review),
    });
  } catch (error) {
    return json(res, 500, { error: clip(error?.message || error, 300) });
  }
});

route('GET', '/api/project/:id/standards', (req, res, { id: projectId }) => {
  const project = getProject(projectId);
  if (!project) return json(res, 404, { error: 'no such project' });
  return json(res, 200, { ok: true, standards: listStandards(projectId) });
});

route('POST', '/api/session/:id/teach', async (req, res, { id: sessionId }) => {
  const session = getSession(sessionId);
  if (!session) return json(res, 404, { error: 'no such session' });
  if (!session.project_id) return json(res, 400, { error: 'this session has no project for a durable rule' });
  const body = await readJson(req).catch(() => ({}));
  const rule = String(body.rule || '').replace(/\s+/g, ' ').trim();
  if (rule.length < 20) return json(res, 400, { error: 'write a specific rule (at least 20 characters)' });
  if (rule.length > 1000) return json(res, 413, { error: 'rule is too long (max 1000 characters)' });
  const focusTs = Number(body.focus_ts) || 0;
  const sourceRef = `session:${sessionId}${focusTs ? `:event:${focusTs}` : ''}`;
  const standardId = addStandard(session.project_id, rule, { sourceRef, sessionId });
  const standard = getStandard(session.project_id, standardId);
  addEvent(sessionId, 'project-rule-taught', { standard_id: standardId, focus_ts: focusTs, rule });
  bus.emit('changed');
  return json(res, 200, { ok: true, standard });
});

route('POST', '/api/session/:id/teach/:standardId/retry', async (req, res, { id: sessionId, standardId }) => {
  const session = getSession(sessionId);
  if (!session) return json(res, 404, { error: 'no such session' });
  const standard = session.project_id ? getStandard(session.project_id, standardId) : null;
  if (!standard || standard.status !== 'active') return json(res, 404, { error: 'no active project rule' });
  const message = [
    'Apply this newly approved project rule while correcting the current exception:',
    standard.text,
    '',
    'Re-inspect the failure evidence, make the correction, rerun the relevant verification, and continue until the current task is genuinely complete.',
  ].join('\n');
  const result = await deliverReply(sessionId, message, { source: 'text' });
  if (result?.stopped) return json(res, 409, { error: 'session has stopped — resume it to continue', stopped: true });
  if (result?.missing) return json(res, 404, { error: 'no such session' });
  noteStandardsUsed(session.project_id, [standardId], { sessionId });
  addEvent(sessionId, 'project-rule-retry', { standard_id: standardId });
  bus.emit('changed');
  return json(res, 200, { ok: true, resumed: true });
});

route('POST', '/api/project/:id/standards/:standardId/retire', (req, res, { id: projectId, standardId }) => {
  const project = getProject(projectId);
  if (!project) return json(res, 404, { error: 'no such project' });
  if (!retireStandard(projectId, standardId)) return json(res, 404, { error: 'no active project rule' });
  bus.emit('changed');
  return json(res, 200, { ok: true });
});
