import { join, normalize } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { getSession, getProject, getGrant, upsertGrant, addMessage, addEvent, GLOBAL_AGENT_SCOPE } from '../store.js';
import { viewTaskState, routeTaskPatch } from './supervisor/task_state.js';
import { recordUsage, getSessionLimit } from '../usage_store.js';
import { routeForModel } from '../model_catalog.js';
import { resume as resumeSessionById, sendText, noteReply, paneSig } from '../sessions.js';
import { evaluateSend, emptyKernelState } from './send_kernel.js';
import { consumeCapability } from '../capabilities.js';
import { bus } from '../bus.js';
import { now } from '../util.js';
import { DATA_DIR } from '../config.js';
import { sessionContext, gatherImages, gitHead } from './evidence.js';
import { gitProbe, urlProbe } from './probes.js';
import { callProxyModel, isVisionRoute } from './model.js';
import { activePreviewProfiles, normalizePreviewProfiles } from '../preview_profiles.js';

// The Context (`ctx`) is the ONLY surface a panel agent may touch — it must never import db/bus/
// sendText directly. Every acting/observing method is gated by a declared+granted capability. This
// is the public, mostly-irreversible contract third-party agents are written against.

// Caps an operator must grant EXPLICITLY (they let an agent act on the session/filesystem). The rest
// (read-context, screenshot, model-calls) are auto-granted when an agent is enabled — observe/think,
// not act. The Builder's `manage-agents` is high-risk on purpose.
export const HIGH_RISK_CAPS = new Set(['send-input', 'write-files', 'exec', 'manage-agents']);
export const ALL_CAPS = ['read-context', 'screenshot', 'model-calls', 'send-input', 'write-files', 'exec', 'manage-agents'];

export class CapabilityError extends Error {
  constructor(cap, agentId, reason = 'denied') {
    super(`agent '${agentId}' ${reason === 'undeclared' ? 'does not declare' : 'was not granted'} capability '${cap}'`);
    this.name = 'CapabilityError';
    this.code = 'CAP_DENIED';
    this.capability = cap;
    this.reason = reason; // 'undeclared' (programming error) | 'denied' (operator hasn't consented)
  }
}

const AGENTS_DIR = join(DATA_DIR, 'agents');

// Strip control chars and collapse whitespace to one bounded line (for anything sent to a CLI pane).
function oneLine(s) {
  return String(s || '')
    .split('')
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

// SEND KERNEL wrapper (v4 Phase 0) — the ONE place agent text becomes pane keystrokes. State is
// per-session (the pane is shared: two agents alternating identical nudges must share one budget).
// Every verdict is audited to the events table; blocks that merit operator attention notify once
// per incident (the kernel's escalateKey dedupes).
const kernelStates = new Map(); // session_id -> kernel state
function mediateSend(agent, session_id, s, kind, text, lease, intentName, budgetKey) {
  const st = kernelStates.get(session_id) || emptyKernelState();
  let v = evaluateSend(st, { kind, text, paneSig: paneSig(session_id), lease, intentName, budgetKey }, now());
  // CAPABILITY CONSULT (S1): a reserved block converts to a send IFF an operator-minted capability
  // for exactly this class + scope consumes. Re-evaluate with the waiver so lease/dedupe/rate/breaker
  // still apply — authority covers the action, not spam. v1's state (escalation bump) is discarded on
  // success; the consumption itself is the audit anchor.
  if (!v.allowed && v.reason.startsWith('kernel-reserved:')) {
    const cls = v.reason.slice('kernel-reserved:'.length);
    let cap = null;
    try { cap = consumeCapability({ sessionId: session_id, action: cls, scopeText: text }); } catch (e) { console.error('[aios] capability consult failed:', e?.message || e); }
    if (cap) {
      v = evaluateSend(st, { kind, text, paneSig: paneSig(session_id), lease, intentName, budgetKey, reservedWaiver: cls }, now());
      addEvent(session_id, 'capability-consumed', { agent: agent.id, capability: cap.id, action: cls, minted_by: cap.minted_by, allowed: v.allowed });
    }
  }
  kernelStates.set(session_id, v.state);
  addEvent(session_id, 'send-kernel', { agent: agent.id, kind, allowed: v.allowed, reason: v.reason || '' });
  // Receipt of the PREVIOUS allowed send, resolved by observation (pane moved / timeout) — the S3
  // metric row: sends-without-receipt must be zero on a healthy session.
  if (v.receipt) addEvent(session_id, 'send-receipt', { agent: agent.id, id: v.receipt.id, received: v.receipt.received, ms: v.receipt.ms });
  if (!v.allowed && v.escalate) {
    bus.emit('notify', {
      title: 'Supervisor send blocked',
      body: `${v.reason} — ${String(text || '').slice(0, 110)}`,
      url: v.reason.startsWith('kernel-reserved:')
        ? `session?id=${session_id}&mint=${v.reason.slice('kernel-reserved:'.length)}`
        : `session?id=${session_id}`,
      tag: `kernel-${session_id}-${v.escalateKey}`,
    });
    bus.emit('event', { type: 'agent', agent: agent.id, kind: 'kernel-escalation', session: session_id, reason: v.reason });
  }
  return v;
}

export function makeContext(agent, session_id, extra = {}) {
  const isGlobal = session_id === GLOBAL_AGENT_SCOPE;
  const declared = (cap) => (agent.capabilities || []).includes(cap);
  const grantCaps = () => getGrant(session_id, agent.id)?.caps || [];
  const hasCap = (cap) => declared(cap) && grantCaps().includes(cap);
  const requireCap = (cap) => {
    if (!declared(cap)) throw new CapabilityError(cap, agent.id, 'undeclared');
    if (!grantCaps().includes(cap)) throw new CapabilityError(cap, agent.id, 'denied');
  };

  return {
    agentId: agent.id,
    sessionId: session_id,
    isGlobal,
    trigger: extra.trigger || null,
    hasCap,
    requireCap,
    log: (...a) => console.log(`[agent:${agent.id}]`, ...a),

    // ---- read-context -------------------------------------------------------
    session() {
      requireCap('read-context');
      return getSession(session_id);
    },
    project() {
      requireCap('read-context');
      const s = getSession(session_id);
      return s?.project_id ? getProject(s.project_id) : null;
    },
    // Structured evidence; pass {screenshot:true} to also capture the configured preview URL.
    async getEvidence(opts = {}) {
      requireCap('read-context');
      const s = getSession(session_id);
      if (!s) throw new Error('session not found');
      const data = await sessionContext(s, { terminalMax: opts.terminalMax ?? 16000, includeDiff: opts.diff !== false, baseRef: opts.baseRef ?? null });
      if (opts.screenshot) {
        requireCap('screenshot');
        const gcfg = getGrant(session_id, agent.id)?.config || {};
        const configuredProfiles = Array.isArray(gcfg.preview_profiles) ? normalizePreviewProfiles(gcfg) : [];
        const preview_url = opts.preview_url ?? (configuredProfiles.length ? '' : (gcfg.preview_url || ''));
        // gated-preview auth: read the RAW passcode from the stored grant config (never from the browser view,
        // which is redacted). Injected as HTTP Basic by the CDP grabber so it can see a login-gated UI.
        const preview_auth = opts.preview_auth || (gcfg.preview_passcode_gated && gcfg.preview_passcode
          ? { username: gcfg.preview_username || '', passcode: gcfg.preview_passcode }
          : null);
        const preview_profiles = opts.preview_profiles || (configuredProfiles.length ? activePreviewProfiles(gcfg) : []);
        data.images = await gatherImages(s, { preview_url, preview_auth, preview_profiles, product_audit: opts.product_audit || null }).catch(() => []);
      }
      return data;
    },
    // EVIDENCE PROBES (v4 Phase 2, A1/A5): system-collected provenance envelopes — the typed
    // alternative to "done on my word". Git truth for the session's repo + optional URL liveness.
    async runProbes({ urls = [] } = {}) {
      requireCap('read-context');
      const s = getSession(session_id);
      const proj = s?.project_id ? getProject(s.project_id) : null;
      const out = [];
      if (proj?.path) out.push(await gitProbe(proj.path));
      for (const u of urls.slice(0, 4)) out.push(await urlProbe(String(u)));
      return out;
    },

    // Current HEAD sha of the session's project — the supervisor captures this as a baseline so later
    // reviews can see work already committed (read-only, no acting).
    async gitHead() {
      requireCap('read-context');
      const s = getSession(session_id);
      const proj = s?.project_id ? getProject(s.project_id) : null;
      return proj?.path ? gitHead(proj.path) : null;
    },

    // ---- model-calls (metered + attributed) ---------------------------------
    visionRoute(modelId) {
      const id = modelId || getGrant(session_id, agent.id)?.config?.model || agent.defaults?.model;
      return id ? isVisionRoute(routeForModel(id)) : false;
    },
    async callModel(messages, opts = {}) {
      requireCap('model-calls');
      const lim = isGlobal ? null : getSessionLimit(session_id);
      if (lim?.enabled && lim.triggered_at) throw new Error('session usage limit reached');
      const modelId = opts.model || getGrant(session_id, agent.id)?.config?.model || agent.defaults?.model;
      if (!modelId) throw new Error('no model configured for this agent');
      const route = routeForModel(modelId);
      const res = await callProxyModel(route, messages, opts);
      try {
        const u = res.usage || {};
        recordUsage({
          source_id: `agent:${agent.id}:${session_id}:${now()}:${Math.round(Math.random() * 1e9)}`,
          source: 'agent',
          event_type: 'agent_model_call',
          ts: now(),
          session_id: isGlobal ? null : session_id,
          tool: `agent:${agent.id}`,
          provider: route.proxy,
          model: res.model || route.model,
          input_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
          output_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
          cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens ?? 0,
          reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
          total_tokens: u.total_tokens ?? 0,
        });
      } catch (e) {
        console.error(`[agent:${agent.id}] usage record failed:`, e.message);
      }
      return { ...res, route, canSee: isVisionRoute(route) };
    },

    // ---- send-input (the dangerous one: injects into a bypass-mode CLI) ------
    // `kind` is the send's typed lane (send_policy SEND_KINDS); the kernel fails closed on unknown
    // kinds, so callers must declare what a send IS, not just what it says. 'operator' = the
    // operator's own relayed words — kernel-exempt.
    async sendToAgent(text, { guarded = true, blockDecision = guarded, kind = 'nudge', lease = null, intentName = '', budgetKey = '' } = {}) {
      requireCap('send-input');
      const s = getSession(session_id);
      if (!s) throw new Error('session not found');
      const msg = oneLine(text).slice(0, 1500);
      if (!msg) return { sent: false, reason: 'empty' };
      // `guarded` = never interrupt a working agent (require waiting). `blockDecision` (defaults to
      // guarded) = don't answer a question the agent is asking the user; callers can opt to send anyway.
      // `lease` = { paneSig } from when the proposer started reasoning — CAS: stale pane, no send.
      if (guarded && s.status !== 'waiting') return { sent: false, reason: 'not-waiting' };
      if (blockDecision && s.category === 'decision') return { sent: false, reason: 'decision' };
      const k = mediateSend(agent, session_id, s, kind, msg, lease, intentName, budgetKey);
      if (!k.allowed) return { sent: false, reason: k.reason, kernel: true };
      await sendText(s.tmux, `[${agent.name || agent.id}] ${msg}`);
      addMessage(session_id, 'in', `agent:${agent.id}`, msg);
      addEvent(session_id, 'agent-send', { agent: agent.id, len: msg.length });
      noteReply(session_id);
      return { sent: true, message: msg };
    },

    // Send a RAW slash command (e.g. /compact) to the agent's composer — no "[name]" prefix, since a
    // prefixed "/compact" wouldn't be recognized by the TUI. send-input gated; restricted to "/" commands.
    async sendCommand(cmd, { guarded = false, kind = 'recover' } = {}) {
      requireCap('send-input');
      const s = getSession(session_id);
      if (!s) throw new Error('session not found');
      const c = oneLine(cmd).slice(0, 120);
      if (!c.startsWith('/')) return { sent: false, reason: 'not-a-command' };
      if (guarded && s.status !== 'waiting') return { sent: false, reason: 'not-waiting' };
      const k = mediateSend(agent, session_id, s, kind, c, null, 'RECOVER_COMMAND', ''); // slash-commands ARE the recover intent; no lease (time-critical)
      if (!k.allowed) return { sent: false, reason: k.reason, kernel: true };
      await sendText(s.tmux, c);
      addEvent(session_id, 'agent-command', { agent: agent.id, cmd: c });
      noteReply(session_id);
      return { sent: true, command: c };
    },

    // Current stabilized-pane signature (read-context): the same value the kernel keys its
    // no-effect breaker on. Agents use it for cheap change detection (event gate) without shelling
    // out for a full snapshot.
    paneSig() {
      requireCap('read-context');
      return paneSig(session_id);
    },
    async resumeSession({ force = false } = {}) {
      requireCap('send-input');
      if (isGlobal) throw new Error('global agent cannot resume a session');
      return await resumeSessionById(session_id, { force });
    },

    // ---- write-files (confined to the session's project cwd) ----------------
    async writeProjectFile(rel, content) {
      requireCap('write-files');
      const s = getSession(session_id);
      const proj = s?.project_id ? getProject(s.project_id) : null;
      if (!proj?.path) throw new Error('no project path for this session');
      const base = normalize(proj.path);
      const target = normalize(join(base, rel));
      if (target !== base && !target.startsWith(base + '/')) throw new Error('path escapes project');
      await writeFile(target, content ?? '', 'utf8');
      return target;
    },

    // ---- manage-agents (privileged: write a drop-in agent under data/agents) -
    async scaffoldAgent(id, files = {}) {
      requireCap('manage-agents');
      const clean = String(id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!clean) throw new Error('invalid agent id');
      const dir = normalize(join(AGENTS_DIR, clean));
      if (!dir.startsWith(normalize(AGENTS_DIR) + '/')) throw new Error('invalid agent dir');
      await mkdir(dir, { recursive: true });
      const written = [];
      for (const [name, content] of Object.entries(files)) {
        const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '');
        if (!safe) continue;
        const target = normalize(join(dir, safe));
        if (!target.startsWith(dir + '/')) continue;
        await writeFile(target, String(content ?? ''), 'utf8');
        written.push(safe);
      }
      return { id: clean, dir, written };
    },

    // ---- per-(session,agent) config + scratch state (no cap; the agent's own namespace) ----
    getConfig() {
      return { ...(agent.defaults || {}), ...(getGrant(session_id, agent.id)?.config || {}) };
    },
    setConfig(patch) {
      return upsertGrant(session_id, agent.id, { config: patch }).config;
    },
    // Task-scoped state seam (supervisor/task_state.js): reads resolve the active task-card's
    // fingerprints/counters over the flat legacy keys; writes route scoped keys into the task's
    // bucket. A no-op for every grant without `activeTaskId` (all agents today; supervisor until
    // Project Memory phase 3), so legacy behavior is byte-identical — replay-suite-locked.
    getState() {
      return viewTaskState(getGrant(session_id, agent.id)?.state || {});
    },
    setState(patch) {
      const raw = getGrant(session_id, agent.id)?.state || {};
      return viewTaskState(upsertGrant(session_id, agent.id, { state: routeTaskPatch(raw, patch) }).state);
    },
    sessionLimit() {
      return isGlobal ? null : getSessionLimit(session_id);
    },

    // ---- bus (SSE only; never push) -----------------------------------------
    emit(kind, data = {}) {
      bus.emit('changed');
      if (kind) bus.emit('event', { type: 'agent', agent: agent.id, kind, session: isGlobal ? null : session_id, ...data });
    },

    // ---- operator notification (push to devices; informational, no cap) ------
    // For things the operator should know now even when away: a verified-complete sign-off or an
    // escalation the supervisor won't answer itself. Routed through the bus so context.js needn't
    // import push.js (push.js listens for 'notify'). Low-risk: it informs the human, never acts.
    notifyOperator(title, body, url) {
      bus.emit('notify', {
        title: title || (agent.name || agent.id),
        body: body || '',
        url: url || (isGlobal ? '.' : `session?id=${session_id}`),
        tag: isGlobal ? agent.id : session_id,
      });
    },
  };
}
