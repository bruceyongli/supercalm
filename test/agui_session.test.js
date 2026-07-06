import assert from 'node:assert/strict';
import {
  buildAgentGroups,
  buildAgentTimelinePayload,
  timelineToAguiEvents,
  validateAguiEvents,
} from '../src/agui_session.js';

const session = {
  id: 's_fixture',
  tool: 'codex',
  toolLabel: 'Codex',
  model: 'gpt-5-codex',
  modelLabel: 'GPT-5 Codex',
  status: 'running',
  title: 'Implement Agent View',
  started_at: 1781177040000,
};

const timeline = {
  generatedAt: 1781177065000,
  stats: {
    messages: 4,
    decisions: 1,
    attachments: 2,
    events: 3,
    diffs: 1,
  },
  blocks: [
    {
      id: 'session-start',
      type: 'event',
      subtype: 'session',
      ts: 1781177040000,
      title: 'Session created',
      summary: 'codex · gpt-5-codex · Implement Agent View',
      payload: { cwd: '/Users/host/aios' },
    },
    {
      id: 'm-user-1',
      type: 'message',
      role: 'user',
      ts: 1781177041000,
      title: 'User request',
      summary: 'Add a second selectable Agent View',
      text: 'Add AG-UI first, then make the Manus message pattern.',
      attachments: [
        {
          name: 'reference.png',
          type: 'image/png',
          size: 48012,
          path: '/tmp/reference.png',
          format: 'PNG',
          isImage: true,
          url: '/api/session/s_fixture/attachment/reference.png',
        },
      ],
    },
    {
      id: 'e-search',
      type: 'event',
      subtype: 'research',
      ts: 1781177043000,
      title: 'Reference research',
      summary: 'Compared Manus and Claude Desktop task timelines.',
      payload: { sources: ['manus', 'claude'] },
    },
    {
      id: 'd-confirm',
      type: 'decision',
      category: 'implementation',
      status: 'answered',
      ts: 1781177045000,
      title: 'Direction confirmed',
      summary: 'Proceed with AG-UI first, CopilotKit later only if needed.',
      ask: 'Use AG-UI or keep iterating manually?',
      response: 'Add AG-UI first.',
    },
    {
      id: 'm-agent-1',
      type: 'message',
      role: 'agent',
      ts: 1781177047000,
      title: 'Agent response',
      summary: 'Adapter and Agent View plan prepared.',
      text: 'I will add a lazy-loaded Agent View and request-grouped renderer.',
    },
    {
      id: 'm-user-2',
      type: 'message',
      role: 'user',
      ts: 1781177050000,
      title: 'User request',
      summary: 'Keep side panel visible',
      text: 'Do not hide the side map/usage panel.',
      attachments: [
        {
          name: 'notes.md',
          type: 'text/markdown',
          size: 1204,
          path: '/tmp/notes.md',
          format: 'MD',
          isImage: false,
          url: '/api/session/s_fixture/attachment/notes.md',
        },
      ],
    },
    {
      id: 'diff-current-request',
      type: 'diff',
      scope: 'request',
      ts: 1781177057000,
      title: 'Request changes',
      summary: '2 changed paths since this request started',
      project: 'aios',
      root: '/Users/host/aios',
      status: ' M web/session.html\n M web/session.js',
      stat: 'web/session.html\t+8 -0\nweb/session.js\t+120 -7',
      diff: [
        'diff --git a/web/session.js b/web/session.js',
        'index 1111111..2222222 100644',
        '--- a/web/session.js',
        '+++ b/web/session.js',
        '@@ -1,3 +1,4 @@',
        '+import "./agent_view.js";',
      ].join('\n'),
      truncated: false,
      error: '',
    },
    {
      id: 'terminal-tail',
      type: 'terminal',
      ts: 1781177060000,
      title: 'Terminal tail',
      summary: 'Latest 80 terminal lines',
      text: 'npm test\nPASS test/agui_session.test.js\nnode --check src/agui_session.js',
      truncated: false,
    },
  ],
};

function allSourceBlockIds(groups) {
  return new Set(groups.flatMap((g) => g.sourceRefs.map((r) => r.blockId).filter(Boolean)));
}

const requiredEventTypes = [
  'RUN_STARTED',
  'STATE_SNAPSHOT',
  'MESSAGES_SNAPSHOT',
  'STEP_STARTED',
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
  'CUSTOM',
  'TOOL_CALL_START',
  'TOOL_CALL_RESULT',
  'TOOL_CALL_END',
];

{
  const groups = buildAgentGroups(timeline.blocks, session);
  assert.equal(groups.length, 3, 'setup plus two user-request groups');
  assert.equal(groups.filter((g) => g.kind === 'request').length, 2, 'each user request gets a primary group');
  assert.equal(groups.at(-1).changes.length, 1, 'diff evidence is grouped under latest request');
  assert.equal(groups.at(-1).terminal.length, 1, 'terminal evidence is grouped under latest request');
  assert.equal(groups[1].artifacts.some((a) => a.kind === 'image'), true, 'image attachment becomes artifact');
  assert.equal(groups[2].artifacts.some((a) => a.kind === 'file'), true, 'file attachment becomes artifact');
  assert.equal(groups[2].artifacts.some((a) => a.kind === 'code-change' && a.path === 'web/session.js'), true, 'diff file becomes artifact');

  const ids = allSourceBlockIds(groups);
  for (const block of timeline.blocks) {
    assert.equal(ids.has(block.id), true, `source metadata preserved for ${block.id}`);
  }
}

{
  const payloadA = buildAgentTimelinePayload({ session, timeline });
  const payloadB = buildAgentTimelinePayload({ session, timeline });
  assert.deepEqual(payloadA, payloadB, 'payload generation is deterministic');
  assert.deepEqual(
    payloadA.events.map((event) => event.eventId),
    payloadB.events.map((event) => event.eventId),
    'AG-UI event IDs are stable'
  );
  validateAguiEvents(payloadA.events);
  for (const type of requiredEventTypes) {
    assert.equal(payloadA.agui.eventTypes.includes(type), true, `AG-UI event category covered: ${type}`);
  }
  assert.equal(payloadA.groups.at(-1).changes[0].files.length, 2, 'changed files parsed from stat/status');
  assert.equal(payloadA.groups.at(-1).changes[0].files.some((f) => f.path === 'web/session.html'), true, 'HTML change retained');
  assert.equal(payloadA.groups.at(-1).changes[0].files.some((f) => f.path === 'web/session.js'), true, 'JS change retained');
}

{
  const events = timelineToAguiEvents({ session: { ...session, status: 'exited' }, timeline });
  validateAguiEvents(events);
  assert.equal(events.at(-1).type, 'RUN_FINISHED', 'exited sessions emit RUN_FINISHED');
}

console.log('agui_session tests passed');
