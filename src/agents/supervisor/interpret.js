const QUESTION_ONLY_WINDOW_MS = Number(process.env.AIOS_SUPERVISOR_QUESTION_ONLY_WINDOW_MS || 60 * 60 * 1000);

export const OPERATOR_ACK_RX = /\b(ok|okay|confirmed?|i saw|looks good|works? now|working now|that's good|that is good|yes\b|approved?|ship it|move on|go ahead)\b/i;
export const QUESTION_ONLY_RX = /\b(answer|explain|diagnose|tell me|why|what|where|which|whether|can you see|find)\b[^.!?\n]{0,160}\b(only|just answer|answer only|read-?only|no fix|don'?t fix|do not fix|without fixing|don'?t change|do not change|no code|don'?t implement|do not implement|don'?t deploy|do not deploy)\b|\b(not ask for fixing anything|not asking for fixing|not ask for a fix|answer my question only|just answer my question)\b/i;
export const OPERATOR_WAIT_RX = /\b(wait|hold on|pause|stop|stand down|do nothing|don'?t do anything|do not do anything|don'?t send|do not send|leave it|no more messages|stay quiet)\b/i;
export const OPERATOR_CONTINUE_RX = /\b(go ahead|move on|keep working|continue|proceed|do it|start it|implement|fix it|ship it|deploy it|be aggressive|don'?t stop|do not stop|keep going|fix (?:all|the|these|those)?[^.\n]{0,60}\bissues?\b|start using multiple sub-?agents|speed things up)\b/i;
export const OPERATOR_CORRECTION_RX = /\b(no\b|wrong|incorrect|not what i asked|missed|ignored|fix that|bug|regression|dumb|blindly|should have|shouldn't have|do not repeat)\b/i;
export const OPERATOR_SCOPE_RX = /\b(add|also|instead|change scope|new requirement|now do|next do|then do|remaining|what's left)\b/i;
export const OPERATOR_STATUS_QUESTION_RX = /\b(what (?:are you|were you|is (?:the )?(?:agent|supervisor)) (?:working on|waiting for|doing)|why (?:is|did|didn'?t|does|doesn'?t) .*?(?:stop|stopped|idle|wait|waiting|ignore|ignored|miss|missed)|is (?:the )?(?:agent|supervisor|session) still (?:working|running)|status\??)\b/i;
// NB: the operator's standing "keep going / finish all phases" delegation is no longer regex-matched here —
// it is read semantically into a DURABLE stance (src/agents/supervisor/stance.js) and drives decide.js from
// there. classifyOperatorText below survives only as the deterministic fallback when the model is down.
export const COMPLETION_CLAIM_RX = /\b(done|complete|completed|finished|implemented|fixed|resolved|verified|all set|ready for sign.?off)\b/i;
export const EVIDENCE_SUPPLIED_RX = /\b(test|tests|passed|screenshot|api output|curl|command output|render|deployed|version|commit|diff|proof|evidence)\b/i;
export const BLOCKED_RX = /\b(blocked|stuck|can't|cannot|unable|need access|permission|credential|auth|login|required)\b/i;
export const FORWARDED_REPORT_RX = /^\s*(?:>+\s*)?(?:\[(?:from\s+)?(?:claude|codex|supervisor|agent|coding agent)[^\]]*\]|(?:claude|codex|supervisor|agent|coding agent)\s*(?:status|replied|said|reported|->|:)|(?:claude|codex|supervisor|agent|coding agent)\b\s+(?:is|was|will|had|has|deployed|applied|finished|completed|taking|revising|doing|continuing|follow-up|checkpoint|deploy complete|admin cleanup)\b|(?:status|report)\s+from\s+(?:claude|codex|agent))\s*:?\s*/i;

function oneLine(s, max = 220) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function confidence(kind, text) {
  if (kind === 'none') return 0;
  if (kind === 'question_only' && /answer my question only|just answer my question|not ask.*fix/i.test(text)) return 0.98;
  if (kind === 'wait' && /do nothing|stand down|stay quiet/i.test(text)) return 0.98;
  if (kind === 'continue' && /keep working|keep going|do not stop|don't stop/i.test(text)) return 0.95;
  if (kind === 'status_question') return 0.9;
  return 0.82;
}

export function classifyOperatorText(text) {
  const t = String(text || '');
  let kind = 'none';
  let matched = '';
  if (QUESTION_ONLY_RX.test(t)) { kind = 'question_only'; matched = 'QUESTION_ONLY_RX'; }
  else if (OPERATOR_STATUS_QUESTION_RX.test(t)) { kind = 'status_question'; matched = 'OPERATOR_STATUS_QUESTION_RX'; }
  else if (OPERATOR_CONTINUE_RX.test(t)) { kind = 'continue'; matched = 'OPERATOR_CONTINUE_RX'; }
  else if (OPERATOR_WAIT_RX.test(t)) { kind = 'wait'; matched = 'OPERATOR_WAIT_RX'; }
  else if (OPERATOR_ACK_RX.test(t)) { kind = 'ack'; matched = 'OPERATOR_ACK_RX'; }
  else if (OPERATOR_CORRECTION_RX.test(t)) { kind = 'correction'; matched = 'OPERATOR_CORRECTION_RX'; }
  else if (OPERATOR_SCOPE_RX.test(t)) { kind = 'scope_change'; matched = 'OPERATOR_SCOPE_RX'; }
  return { kind, confidence: confidence(kind, t), evidence: matched ? [{ source: 'regex', rule: matched, text: oneLine(t) }] : [], text: oneLine(t) };
}

function forwardedPrefix(raw) {
  const m = String(raw || '').match(FORWARDED_REPORT_RX);
  return m ? m[0] : '';
}

function splitMixedForwardedLine(raw) {
  const line = String(raw || '').trim();
  const prefix = forwardedPrefix(line);
  if (!prefix) return null;
  const rest = line.slice(prefix.length).trim();
  if (!rest) return [{ label: 'forwarded_report', text: oneLine(line), confidence: 0.9 }];
  const parts = rest.split(/\s+(?:[-–—]{1,2}|;)\s+/);
  if (parts.length < 2) return [{ label: 'forwarded_report', text: oneLine(line), confidence: 0.9 }];
  const tail = parts.slice(1).join(' - ');
  const tailIntent = classifyOperatorText(tail);
  if (tailIntent.kind === 'none') return [{ label: 'forwarded_report', text: oneLine(line), confidence: 0.9 }];
  return [
    { label: 'forwarded_report', text: oneLine(prefix + parts[0]), confidence: 0.88 },
    { label: 'operator_directive', text: tailIntent.text, intent: tailIntent.kind, confidence: tailIntent.confidence, evidence: tailIntent.evidence },
  ];
}

export function segmentOperatorMessage(text) {
  const raw = String(text || '');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean) continue;
    const mixed = splitMixedForwardedLine(clean);
    if (mixed) {
      out.push(...mixed);
      continue;
    }
    if (/^\s*>/.test(line)) {
      out.push({ label: 'forwarded_report', text: oneLine(clean.replace(/^>+\s*/, '')), confidence: 0.75 });
      continue;
    }
    const intent = classifyOperatorText(clean);
    if (intent.kind !== 'none') {
      out.push({ label: 'operator_directive', text: intent.text, intent: intent.kind, confidence: intent.confidence, evidence: intent.evidence });
    } else {
      out.push({ label: 'commentary', text: oneLine(clean), confidence: 0.65 });
    }
  }
  return out;
}

export function classifyAgentText(text) {
  const t = String(text || '');
  const labels = [];
  if (COMPLETION_CLAIM_RX.test(t)) labels.push('completion_claim');
  if (EVIDENCE_SUPPLIED_RX.test(t)) labels.push('evidence_supplied');
  if (BLOCKED_RX.test(t)) labels.push('blocked');
  return labels;
}

export function latestOperatorIntentFromSignals(signals, t = Date.now(), windowMs = QUESTION_ONLY_WINDOW_MS) {
  const messages = Array.isArray(signals?.messages) ? signals.messages : [];
  for (const m of messages) {
    const ts = Number(m?.ts || 0);
    if (ts && t - ts > windowMs) continue;
    const segments = segmentOperatorMessage(m?.text || '');
    const directive = segments.find((seg) => seg.label === 'operator_directive' && seg.intent && seg.intent !== 'none');
    if (directive) {
      return {
        kind: directive.intent,
        confidence: directive.confidence,
        evidence: directive.evidence || [],
        message: m,
        text: directive.text,
        ts,
      };
    }
  }
  return null;
}

export function intentForDecision(intent) {
  if (!intent) return { type: 'none', text: '', ts: null, confidence: 0 };
  return {
    type: intent.kind || 'none',
    text: oneLine(intent.message?.text || intent.text || ''),
    ts: intent.message?.ts || intent.ts || null,
    confidence: Number(intent.confidence || 0),
  };
}
