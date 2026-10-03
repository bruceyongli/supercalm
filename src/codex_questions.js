// Observe only bounded newly-written native rollout bytes. No model call, terminal heuristics or
// full-history parsing is needed to make async questions visible while the coding agent keeps working.
import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { codexRolloutFiles, pickRolloutByUuid } from './codex_rollouts.js';
import { codexQuestionCall, storedQuestion, questionEvents } from './codex_question.js';
import * as store from './store.js';
import { createAttentionReport, clearAttentionDismissal, attentionUnreadCount, markAttentionReportRead } from './attention_store.js';
import { sessionStatusPayload } from './session_projection.js';
import { bus } from './bus.js';

const readers = new Map();
let files = [], inventoryAt = 0, inventoryFlight = null;
const MAX_BYTES = 1024 * 1024;
const latestInput = store.db.prepare("SELECT ts, text FROM messages WHERE session_id=? AND direction='in' ORDER BY id DESC LIMIT 1");

export function rememberCodexQuestion(sid, prompt) {
  const session = store.getSession(sid);
  if (!session || prompt.mode !== 'async' || !prompt.id) return null;
  const previous = storedQuestion(session);
  if (previous?.id === prompt.id || Number(previous?.ts || 0) > prompt.ts) return previous;
  const reply = latestInput.get(sid);
  const answered = !!reply && Number(reply.ts) >= prompt.ts;
  let report = null;
  if (!answered) {
    report = createAttentionReport(sid, prompt.questions.map(q => q.question).join('\n'));
    if (report.created) clearAttentionDismissal(sid);
  }
  const current = { ...prompt, answered, reportId: report?.message?.id || null, ...(answered ? { answeredWith: reply.text.slice(0, 200) } : {}) };
  const updated = store.updateSession(sid, { structured_question: JSON.stringify(current) });
  store.addEvent(sid, 'codex-async-question', { call_id: prompt.id, questions: prompt.questions.length, answered });
  bus.emit('session-status', sessionStatusPayload(updated, { source: 'codex-async-question', extra: {
    unread: attentionUnreadCount(sid),
    ...(report?.created ? { dismissed: false, last_key: report.message } : {}),
  } }));
  bus.emit('changed');
  return current;
}

export function resolveCodexQuestion(sid, text = latestInput.get(sid)?.text || '') {
  const session = store.getSession(sid), prompt = storedQuestion(session);
  if (prompt?.mode !== 'async' || prompt.answered) return;
  const updated = store.updateSession(sid, { structured_question: JSON.stringify({ ...prompt, answered: true, answeredWith: String(text || '').slice(0, 200) }) });
  if (prompt.reportId) markAttentionReportRead(prompt.reportId);
  bus.emit('session-status', sessionStatusPayload(updated, { source: 'codex-question-answered', extra: { unread: attentionUnreadCount(sid) } }));
  bus.emit('changed');
}

export function overlayCodexQuestions(session, events) {
  const prompt = storedQuestion(session);
  if (!prompt) return events;
  const reply = latestInput.get(session.id);
  const answered = prompt.answered || (!!reply && Number(reply.ts) >= prompt.ts);
  const authoritative = { ...prompt, answered, answeredWith: prompt.answeredWith || (answered ? reply?.text?.slice(0, 200) : undefined) };
  const existing = events.filter(e => e.kind === 'ask' && e.askId === prompt.id);
  const patched = events.map(e => e.kind === 'ask' && e.askId === prompt.id && answered
    ? { ...e, answered: true, answeredWith: authoritative.answeredWith } : e);
  // Keep a pending question visible even if subsequent work moved it outside the recent Story page.
  return !existing.length && !answered ? [...patched, ...questionEvents(authoritative)].sort((a, b) => a.ts - b.ts) : patched;
}

export async function refreshCodexQuestions(session, { file: suppliedFile = null } = {}) {
  if (session?.tool !== 'codex' || (!suppliedFile && !session.codex_uuid)) return;
  let reader = readers.get(session.id);
  if (!reader || reader.uuid !== session.codex_uuid || (suppliedFile && reader.file !== suppliedFile)) {
    reader = { uuid: session.codex_uuid, file: suppliedFile, offset: null, partial: '', decoder: new StringDecoder('utf8'), busy: false };
    readers.set(session.id, reader);
    if (readers.size > 200) readers.delete(readers.keys().next().value);
  }
  if (reader.busy) return;
  reader.busy = true;
  try {
    if (!reader.file) {
      if (Date.now() - inventoryAt > 30_000) {
        inventoryFlight ||= codexRolloutFiles().then(result => { files = result; inventoryAt = Date.now(); }).finally(() => { inventoryFlight = null; });
        await inventoryFlight;
      }
      reader.file = pickRolloutByUuid(files, session.codex_uuid);
      if (!reader.file) return;
    }
    const handle = await open(reader.file, 'r');
    try {
      const { size } = await handle.stat();
      if (size === reader.offset) return;
      const previousOffset = reader.offset;
      const start = Math.max(previousOffset != null && previousOffset <= size ? previousOffset : 0, size - MAX_BYTES);
      const skipped = previousOffset == null || start !== previousOffset;
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      if (skipped) reader.decoder = new StringDecoder('utf8');
      let chunk = reader.decoder.write(buffer.subarray(0, bytesRead));
      if (skipped && start > 0) chunk = chunk.slice(chunk.indexOf('\n') + 1);
      const lines = ((skipped ? '' : reader.partial) + chunk).split('\n');
      reader.partial = lines.pop().slice(-MAX_BYTES); reader.offset = start + bytesRead;
      for (const line of lines) {
        let item; try { item = JSON.parse(line); } catch { continue; }
        if (item.type !== 'response_item') continue;
        const prompt = codexQuestionCall(item.payload);
        if (prompt?.mode === 'async') rememberCodexQuestion(session.id, { ...prompt, ts: Date.parse(item.timestamp) || Date.now() });
        else if (item.payload?.type === 'message' && item.payload.role === 'user') {
          const pending = storedQuestion(store.getSession(session.id));
          if (pending && Date.parse(item.timestamp) > pending.ts) {
            const text = (item.payload.content || []).map(c => c.text || '').join('\n');
            if (text.trim() && !/^\s*\[Supervisor\]/i.test(text)) resolveCodexQuestion(session.id, text);
          }
        }
      }
    } finally { await handle.close(); }
  } catch (e) {
    if (e.code === 'ENOENT') reader.file = null;
  } finally { reader.busy = false; }
}
