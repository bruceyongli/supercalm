import { execFile } from 'node:child_process';
import { readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR } from '../config.js';
import { curatedModels, parseJsonObject } from './model.js';

// Agent Builder — a global, privileged agent that scaffolds/edits OTHER agents from a natural-language
// spec, using ctx.callModel (the SDK contract is in its system prompt) + ctx.scaffoldAgent (the
// `manage-agents` capability). Generated agents are syntax-checked, then written to data/agents/<id>/
// ALWAYS DISABLED with ZERO granted capabilities — the operator reviews them and grants caps in the
// Agents tab. The builder can never grant capabilities (privilege-escalation guard).

const DEFAULT_MODEL = process.env.AIOS_BUILDER_MODEL || 'gemini-pro-agent';
const AGENTS_DIR = join(DATA_DIR, 'agents');

const SYS_BUILD = `You are the Supercalm Agent Builder. You generate a "panel agent" for the Supercalm agent SDK from the operator's spec.

Return STRICT JSON only: {"id":"kebab-id","name":"Human Name","files":{"agent.json":"<string>","backend.js":"<string>","panel.js":"<string>"}}.
- "backend.js" is optional for read-only (kind:"view") agents. "panel.js" is the browser UI (always include it).
- Each file value is the FULL file contents as a JSON string.

agent.json (the manifest) shape:
{
  "id": "kebab-id", "name": "Human Name", "version": "1.0.0", "description": "one line",
  "kind": "view" | "agent",            // "view" = read-only; "agent" = acts on the session
  "scope": "session" | "global",
  "capabilities": [ ...subset of: "read-context","screenshot","model-calls","send-input","write-files","exec","manage-agents" ],
  "ui": { "tab": "Short Tab Label", "order": 50 },
  "tick": false,                        // true to be called on the host schedule
  "defaults": { ... }                   // default config
}
Declare the MINIMUM capabilities needed. "send-input"/"write-files"/"exec"/"manage-agents" are high-risk and the operator must grant them manually — never assume they are granted.

backend.js (ES module). It is passive — it NEVER imports db/bus/sendText. It only touches the injected ctx. Export any of:
  export const meta = { ...same as agent.json (optional; agent.json wins) };
  export async function onTick(ctx) { ... }                  // periodic work (needs "tick":true)
  export const actions = { async myAction(ctx, body) { return result; } };  // POSTable operations
  export function summary(session_id) { return {...}; }       // cheap read-only data folded into the panel view

ctx API (every method capability-gated; calling an ungranted one throws):
  ctx.sessionId, ctx.agentId, ctx.hasCap(cap), ctx.requireCap(cap), ctx.log(...)
  ctx.session() / ctx.project()                       // read-context
  await ctx.getEvidence({diff,screenshot,terminalMax,preview_url})  // read-context (+screenshot)
  await ctx.callModel(messages, {model,json,maxTokens,temperature}) // model-calls -> {content,usage,canSee}
  await ctx.sendToAgent(text, {guarded})              // send-input -> injects ONE line into the CLI
  await ctx.writeProjectFile(relPath, content)        // write-files (confined to project cwd)
  ctx.getConfig() / ctx.setConfig(patch)              // per-session config (no cap)
  ctx.getState() / ctx.setState(patch)                // per-session scratch state (no cap)
  ctx.emit(kind, data)                                // SSE-only notification

panel.js (browser ES module). Export: export const panel = { mount(hostEl, papi){}, update(view){}, unmount(){} }.
  papi: { sessionId, api, $, escapeHtml, view(), call(action, body), save({config,enabled,caps}), markDirty(), isDirty(), clearDirty() }
  - view() returns the agent's registry entry: { id, name, config, grant:{enabled,caps}, data (from summary), recommend, running }.
  - Call markDirty() on any edit so the host won't clobber it on refresh; clearDirty() after save.
  - Keep the DOM minimal and use class "su-card" for panels to match the dark theme.

Rules: valid JSON, valid JS in every file, no external npm imports, no network except via ctx.callModel. Prefer the smallest capability set. Output JSON only.`;

function buildPrompt(spec, existing) {
  let p = 'SPEC:\n' + spec;
  if (existing) p += '\n\nYou are EDITING an existing agent. Here are its current files — apply the spec and return the full updated files (keep the same id):\n' + JSON.stringify(existing).slice(0, 60000);
  return p + '\n\nReturn the agent as STRICT JSON now.';
}

async function syntaxCheck(code) {
  const tmp = join(tmpdir(), `aios-agent-${Date.now()}-${Math.round(Math.random() * 1e6)}.mjs`);
  try {
    await writeFile(tmp, code, 'utf8');
    await new Promise((res, rej) =>
      execFile(process.execPath, ['--check', tmp], (e, so, se) => (e ? rej(new Error(String(se || e.message).split('\n')[0])) : res()))
    );
    return null;
  } catch (e) {
    return e.message;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

async function readExisting(id) {
  const dir = join(AGENTS_DIR, id);
  const files = {};
  for (const f of ['agent.json', 'backend.js', 'panel.js']) {
    try {
      files[f] = await readFile(join(dir, f), 'utf8');
    } catch {}
  }
  return Object.keys(files).length ? files : null;
}

async function listDropins() {
  try {
    const ents = await readdir(AGENTS_DIR, { withFileTypes: true });
    const out = [];
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      try {
        const m = JSON.parse(await readFile(join(AGENTS_DIR, e.name, 'agent.json'), 'utf8'));
        out.push({ id: m.id || e.name, name: m.name || e.name, kind: m.kind || 'agent', description: m.description || '', capabilities: m.capabilities || [] });
      } catch {
        out.push({ id: e.name, name: e.name, kind: 'unknown', description: '(unreadable manifest)', capabilities: [] });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export const meta = {
  id: 'builder',
  name: 'Agent Builder',
  version: '1.0.0',
  description: 'Scaffold or edit panel agents from a natural-language spec. New agents land disabled with no capabilities — review and grant them in the Agents tab.',
  kind: 'agent',
  scope: 'global',
  capabilities: ['model-calls', 'manage-agents'],
  ui: { tab: 'Builder', order: 90 },
  defaultEnabled: true, // always present (the "agent parent" — manage/create agents from here)
  defaults: { model: DEFAULT_MODEL },
  appliesTo: () => 0.5,
};

export function summary() {
  return { models: curatedModels(DEFAULT_MODEL), defaultModel: DEFAULT_MODEL };
}

export const actions = {
  async models() {
    return { models: curatedModels(DEFAULT_MODEL), agents: await listDropins() };
  },
  async create(ctx, body) {
    const spec = String(body?.spec || body?.description || '').trim();
    if (!spec) throw new Error('describe the agent to build');
    ctx.requireCap('manage-agents'); // fail fast BEFORE spending a model call if write isn't granted
    const model = body?.model || ctx.getConfig().model || DEFAULT_MODEL;
    const existing = body?.editId ? await readExisting(String(body.editId).toLowerCase().replace(/[^a-z0-9_-]/g, '')) : null;
    const r = await ctx.callModel(
      [
        { role: 'system', content: SYS_BUILD },
        { role: 'user', content: buildPrompt(spec, existing) },
      ],
      { model, json: true, maxTokens: 8000, temperature: 0.2 }
    );
    let out;
    try {
      out = parseJsonObject(r.content);
    } catch (e) {
      throw new Error('the model did not return a valid agent: ' + e.message);
    }
    const id = String(out.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!id) throw new Error('the model did not return a valid agent id');
    const files = out.files || {};
    if (!files['agent.json']) throw new Error('the model did not return agent.json');
    let manifest;
    try {
      manifest = JSON.parse(files['agent.json']);
    } catch {
      throw new Error('generated agent.json is not valid JSON');
    }
    for (const f of ['backend.js', 'panel.js']) {
      if (files[f]) {
        const err = await syntaxCheck(files[f]);
        if (err) throw new Error(`generated ${f} has a syntax error: ${err}`);
      }
    }
    // Force-safe the manifest: correct id; capabilities are DECLARED only (operator grants later — the
    // scaffolded agent lands with no grant at all, so it cannot act until explicitly enabled + granted).
    manifest.id = id;
    if (!Array.isArray(manifest.capabilities)) manifest.capabilities = [];
    files['agent.json'] = JSON.stringify(manifest, null, 2);
    const res = await ctx.scaffoldAgent(id, files);
    ctx.emit('built', { id });
    return {
      id,
      name: manifest.name || id,
      kind: manifest.kind || 'agent',
      capabilities: manifest.capabilities,
      written: res.written,
      note: 'Created DISABLED with no granted capabilities. Reload agents, review the code, then enable + grant capabilities in the Agents tab.',
    };
  },
};
