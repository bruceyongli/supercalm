// Native queue admission is delivery, not consumption. Keep accepted operator inputs in Story
// while the native reader is busy/compacting, without inventing turns from helper notifications.
// This overlay is separate from native parsing/paging and never changes completed-round boundaries.
import { cleanUserText, extractAttachmentImages, extractAttachments } from './story.js';
import { unwrapClaudePastedText } from './claude_lifecycle.js';
import { createHash } from 'node:crypto';

const sources = new Set(['text', 'text+attachments', 'voice', 'operator', 'operator-correction', 'phone', 'phone+attachments']);
const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
const paths = event => JSON.stringify([...(event.images || []).map(value => typeof value === 'string' ? value : value.path),
  ...(event.attachments || []).map(value => value.path)].filter(Boolean).sort());
const signature = event => createHash('sha256').update(JSON.stringify([norm(event.body || event.text), paths(event)])).digest('hex');

// Capture compact consumption proofs BEFORE paging. A completed report may window away the first
// two of three queued questions; that must not leave their already-visible bubbles stuck at Queued.
export function nativeInputEvidence(events) {
  const inputs = events.filter(event => event.kind === 'you' && !event.indent).slice(-200);
  return { inputReceipts: inputs.map(event => ({ ts: event.ts, messageId: event.messageId, signature: signature(event) })),
    inputWindowStart: inputs.length ? Math.min(...inputs.map(event => event.ts || 0)) : null };
}

export function reconcileStoryInputs(nativeEvents, rows, { historical = false, receipts = null, windowStart = null } = {}) {
  const events = nativeEvents.map(event => ({ ...event }));
  const first = Math.min(...events.filter(event => event.ts).map(event => event.ts));
  const last = Math.max(0, ...events.map(event => event.ts || 0));
  const used = new Set();
  const inputs = rows.filter(row => row.direction === 'in' && sources.has(row.source) && row.id).map(row => {
    const text = unwrapClaudePastedText(row.text);
    const body = cleanUserText(text);
    const input = { kind: 'you', ts: row.ts, body, inputMessageId: row.id,
      clientMessageId: row.client_message_id || undefined,
      images: extractAttachmentImages(text), attachments: extractAttachments(text),
      delivery: row.delivery_state === 'queued' ? 'queued' : 'sent' };
    return input;
  }).filter(input => input.body || input.images.length || input.attachments.length);
  const signatures = new Map(inputs.map(input => [input.inputMessageId, signature(input)]));
  const evidence = receipts || nativeEvents.filter(event => event.kind === 'you' && !event.indent && !event.delivery)
    .map(event => ({ ts: event.ts, messageId: event.messageId, signature: signature(event) }));
  for (const receipt of evidence) {
    // Complete text + uploads, one receipt per native turn. Prefer its original timestamp, so
    // paging to a later identical request cannot borrow an earlier send's identity.
    const matches = inputs.filter(input => !used.has(input.inputMessageId) && receipt.ts >= input.ts - 20000
      && signatures.get(input.inputMessageId) === receipt.signature)
      .sort((a, b) => Math.abs(receipt.ts - a.ts) - Math.abs(receipt.ts - b.ts));
    const input = matches[0];
    if (!input) continue;
    // Multiple indistinguishable old queues are not enough evidence to claim which one was read.
    if (matches.length > 1 && Math.abs(receipt.ts - input.ts) > 20000) continue;
    used.add(input.inputMessageId);
    const i = events.findIndex(event => event.kind === 'you' && !event.indent && !event.delivery
      && (receipt.messageId ? event.messageId === receipt.messageId : event.ts === receipt.ts && signature(event) === receipt.signature));
    if (i >= 0) events[i] = { ...events[i], inputMessageId: input.inputMessageId, clientMessageId: input.clientMessageId, delivery: 'read' };
  }
  for (const input of inputs) if (!used.has(input.inputMessageId)
    && (input.ts >= (historical ? first : windowStart ?? first) && (!historical || input.ts <= last)
      || !historical && !nativeEvents.length)) events.push(input);
  return { events: events.sort((a, b) => (a.ts || 0) - (b.ts || 0)), readInputIds: [...used] };
}

export const overlayStoryInputs = (events, rows, options) => reconcileStoryInputs(events, rows, options).events;
