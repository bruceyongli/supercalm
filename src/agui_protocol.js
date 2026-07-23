// Repository-native subset of the AG-UI event contract used by Supercalm's read-only timeline adapter.
// Keeping the wire constants and structural validation local avoids pulling a client framework plus Zod
// into the control-plane daemon for thirteen small JSON event shapes.
export const EventType = Object.freeze({
  RUN_STARTED: 'RUN_STARTED',
  RUN_FINISHED: 'RUN_FINISHED',
  RUN_ERROR: 'RUN_ERROR',
  STATE_SNAPSHOT: 'STATE_SNAPSHOT',
  MESSAGES_SNAPSHOT: 'MESSAGES_SNAPSHOT',
  TEXT_MESSAGE_START: 'TEXT_MESSAGE_START',
  TEXT_MESSAGE_CONTENT: 'TEXT_MESSAGE_CONTENT',
  TEXT_MESSAGE_END: 'TEXT_MESSAGE_END',
  STEP_STARTED: 'STEP_STARTED',
  STEP_FINISHED: 'STEP_FINISHED',
  TOOL_CALL_START: 'TOOL_CALL_START',
  TOOL_CALL_RESULT: 'TOOL_CALL_RESULT',
  TOOL_CALL_END: 'TOOL_CALL_END',
  CUSTOM: 'CUSTOM',
});

const KNOWN_TYPES = new Set(Object.values(EventType));
const TEXT_ROLES = new Set(['developer', 'system', 'assistant', 'user']);
const MESSAGE_ROLES = new Set([...TEXT_ROLES, 'tool', 'activity', 'reasoning']);

function requireString(event, key) {
  if (typeof event?.[key] !== 'string') throw new Error(`${key} expected string`);
}

function validateMessage(message, index) {
  if (!message || typeof message !== 'object') throw new Error(`messages.${index} expected object`);
  if (typeof message.id !== 'string') throw new Error(`messages.${index}.id expected string`);
  if (!MESSAGE_ROLES.has(message.role)) throw new Error(`messages.${index}.role unsupported`);
  if (message.content != null && typeof message.content !== 'string' && !Array.isArray(message.content)) {
    throw new Error(`messages.${index}.content expected string or input parts`);
  }
}

export function validateProtocolEvent(event) {
  if (!event || typeof event !== 'object') throw new Error('event expected object');
  if (!KNOWN_TYPES.has(event.type)) throw new Error(`unsupported type ${event.type || '(missing)'}`);
  if (event.timestamp != null && !Number.isFinite(Number(event.timestamp))) throw new Error('timestamp expected number');

  switch (event.type) {
    case EventType.RUN_STARTED:
    case EventType.RUN_FINISHED:
      requireString(event, 'threadId');
      requireString(event, 'runId');
      break;
    case EventType.RUN_ERROR:
      requireString(event, 'message');
      break;
    case EventType.STATE_SNAPSHOT:
      if (!Object.hasOwn(event, 'snapshot')) throw new Error('snapshot required');
      break;
    case EventType.MESSAGES_SNAPSHOT:
      if (!Array.isArray(event.messages)) throw new Error('messages expected array');
      event.messages.forEach(validateMessage);
      break;
    case EventType.TEXT_MESSAGE_START:
      requireString(event, 'messageId');
      if (event.role != null && !TEXT_ROLES.has(event.role)) throw new Error('role unsupported');
      break;
    case EventType.TEXT_MESSAGE_CONTENT:
      requireString(event, 'messageId');
      requireString(event, 'delta');
      break;
    case EventType.TEXT_MESSAGE_END:
      requireString(event, 'messageId');
      break;
    case EventType.STEP_STARTED:
    case EventType.STEP_FINISHED:
      requireString(event, 'stepName');
      break;
    case EventType.TOOL_CALL_START:
      requireString(event, 'toolCallId');
      requireString(event, 'toolCallName');
      break;
    case EventType.TOOL_CALL_RESULT:
      requireString(event, 'messageId');
      requireString(event, 'toolCallId');
      requireString(event, 'content');
      break;
    case EventType.TOOL_CALL_END:
      requireString(event, 'toolCallId');
      break;
    case EventType.CUSTOM:
      requireString(event, 'name');
      if (!Object.hasOwn(event, 'value')) throw new Error('value required');
      break;
  }
  return event;
}
