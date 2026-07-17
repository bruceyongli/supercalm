import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// COMPLETE-MEDIATION CONTRACT (v4 Phase 0, traceability §enforcement guarantee): within the agent
// framework, pane keystrokes exist ONLY behind the send kernel. This test enumerates the actuator
// surface at the source level so a bypass cannot be added silently — if a new agent file imports
// the raw senders, or context.js stops mediating, this fails. (Phase 1 extends the monopoly beyond
// the agent framework: /input, voice, hooks.)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = join(ROOT, 'src', 'agents');

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => join(e.parentPath ?? e.path, e.name));
}

const RAW_SENDERS = /\bimport\s*\{[^}]*\b(sendText|sendKey|sendRaw)\b[^}]*\}\s*from\s*['"][^'"]*sessions\.js['"]/;

// 1) Exactly one file in the agent framework may import the raw senders: context.js.
{
  const offenders = [];
  for (const f of jsFiles(AGENTS)) {
    const src = readFileSync(f, 'utf8');
    if (RAW_SENDERS.test(src) && !f.endsWith(`agents${'/'}context.js`)) offenders.push(f.slice(ROOT.length + 1));
  }
  assert.deepEqual(offenders, [], `agent files must not import raw pane senders (go through ctx): ${offenders.join(', ')}`);
}

// 2) context.js: every raw-sender call site inside the agent-facing methods is preceded by kernel
//    mediation, and the kernel actually gates (a blocked verdict returns before sendText).
{
  const src = readFileSync(join(AGENTS, 'context.js'), 'utf8');
  assert.ok(/import\s*\{[^}]*evaluateSend[^}]*\}\s*from\s*['"]\.\/send_kernel\.js['"]/.test(src),
    'context.js imports the send kernel');
  for (const method of ['sendToAgent', 'sendCommand']) {
    const body = src.slice(src.indexOf(`async ${method}(`));
    const mediate = body.indexOf('mediateSend(');
    const rawSend = body.indexOf('await sendText(');
    assert.ok(mediate > -1, `${method} calls mediateSend`);
    assert.ok(rawSend > -1, `${method} reaches sendText (sanity)`);
    assert.ok(mediate < rawSend, `${method}: mediation precedes the raw send`);
    const between = body.slice(mediate, rawSend);
    assert.ok(/if\s*\(!k\.allowed\)\s*return/.test(between), `${method}: a blocked verdict returns before any keystroke`);
  }
}

// 3) The supervisor dispatch layer declares typed kinds — the kernel fails closed without one.
{
  const src = readFileSync(join(AGENTS, 'supervisor', 'dispatch.js'), 'utf8');
  assert.ok(/kind\s*[:=]/.test(src) && /sendOptions,\s*kind/.test(src.replace(/\n/g, ' ')),
    'dispatchSupervisorSend passes a typed kind into ctx.sendToAgent');
  assert.ok(/hold\.resolve_send/.test(src) && /'operator'/.test(src),
    'the operator relay path maps to the kernel-exempt operator kind');
}


// 4) The capability consult lives at the choke point: a reserved block consults consumeCapability and
//    only a successful consumption re-evaluates with the waiver (never brain-supplied).
{
  const src = readFileSync(join(AGENTS, 'context.js'), 'utf8');
  assert.ok(/consumeCapability\(\{ sessionId: session_id, action: cls, scopeText: text \}\)/.test(src), 'reserved blocks consult capabilities');
  assert.ok(/reservedWaiver: cls/.test(src), 'waiver re-evaluation uses the consumed class only');
  const kernel = readFileSync(join(ROOT, 'src', 'agents', 'send_kernel.js'), 'utf8');
  assert.ok(/reserved !== reservedWaiver/.test(kernel), 'kernel honors exactly the matching waiver');
}

console.log('send_kernel_mediation: all assertions passed');
