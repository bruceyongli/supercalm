// #4 Phase 2 — an embedded Streamable-HTTP MCP server exposing each project's wiki to its launched
// agents (read-only). One endpoint, every session connects: POST /mcp/:token (JSON-RPC 2.0). The token
// scopes a session to ITS project's wiki only (a session can't read another project's). claude wires it
// via --mcp-config (type:http); codex via `mcp_servers.*.url`.
//
// Failure isolation: this is just another route — every handler is wrapped, errors become JSON-RPC
// errors, and a bad request can never wedge the Supercalm http server. Content is model/curated text served
// as tool results (data), never executed.
import { route, json, readJson } from './server.js';
import { VERSION } from './config.js';
import { db } from './store.js';
import { id, now } from './util.js';
import { listWiki, readWiki, searchWiki } from './wiki.js';
import { changedImpact, formatProjectGraphForMcp, projectGraphSummary } from './project_graph_core.js';

db.exec(`CREATE TABLE IF NOT EXISTS mcp_tokens (token TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at TEXT)`);
const _byPid = db.prepare('SELECT token FROM mcp_tokens WHERE project_id = ?');
const _byTok = db.prepare('SELECT project_id FROM mcp_tokens WHERE token = ?');
const _insTok = db.prepare('INSERT INTO mcp_tokens (token, project_id, created_at) VALUES (?,?,?)');

// Stable per-project token (created on first wiring). Long + random enough for localhost-only scoping.
export function wikiMcpToken(pid) {
  const r = _byPid.get(pid);
  if (r) return r.token;
  const tok = 'wk_' + id().replace(/[^a-z0-9]/gi, '') + id().replace(/[^a-z0-9]/gi, '');
  try { _insTok.run(tok, pid, now()); } catch { const again = _byPid.get(pid); if (again) return again.token; throw new Error('token alloc failed'); }
  return tok;
}
function resolveToken(tok) { return _byTok.get(tok)?.project_id || null; }

const PROTOCOL = '2025-06-18';
const TOOLS = [
  { name: 'wiki_search', description: "Search THIS project's knowledge base (curated docs + auto-maintained pages). Returns ranked page snippets. Use it to get oriented before editing.", inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'search terms' } }, required: ['query'] } },
  { name: 'wiki_read', description: 'Read one knowledge-base page in full by its path (paths come from wiki_list / wiki_search).', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'page path, e.g. overview.md or docs/wiki/auth-architecture.md' } }, required: ['path'] } },
  { name: 'wiki_list', description: 'List the knowledge-base pages available for this project.', inputSchema: { type: 'object', properties: {} } },
  { name: 'project_graph_summary', description: 'Summarize THIS project deterministic code graph: indexed commit, stale status, and counts of files/routes/agents/MCP tools/manifests/imports. Treat non-fact confidence as hints.', inputSchema: { type: 'object', properties: {} } },
  { name: 'changed_impact', description: 'Report working-tree changed files and deterministic affected surfaces (routes, agents, MCP tools, manifests) from direct definitions and reverse static imports, with confidence labels.', inputSchema: { type: 'object', properties: {} } },
];

const ok = (mid, result) => ({ jsonrpc: '2.0', id: mid, result });
const err = (mid, code, message) => ({ jsonrpc: '2.0', id: mid, error: { code, message } });
const text = (s) => ({ content: [{ type: 'text', text: String(s) }] });

async function callTool(pid, name, args) {
  if (name === 'wiki_list') {
    const pages = listWiki(pid);
    return text(pages.length ? pages.map((p) => `- ${p.path} — ${p.title || ''}${p.source === 'curated' ? ' [curated]' : ''}`).join('\n') : '(no pages yet — the wiki is empty for this project)');
  }
  if (name === 'wiki_search') {
    const res = searchWiki(pid, String(args?.query || ''));
    return text(res.length ? res.map((r) => `## ${r.path}${r.title ? ` (${r.title})` : ''}\n${r.snippet}`).join('\n\n') : '(no matches)');
  }
  if (name === 'wiki_read') {
    const pg = readWiki(pid, String(args?.path || ''));
    return pg ? text(`# ${pg.title || pg.path}\n\n${pg.content}`) : { ...text(`no such page: ${args?.path}`), isError: true };
  }
  if (name === 'project_graph_summary') {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(pid);
    if (!project) return { ...text('project not found'), isError: true };
    return text(formatProjectGraphForMcp(name, await projectGraphSummary(project)));
  }
  if (name === 'changed_impact') {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(pid);
    if (!project) return { ...text('project not found'), isError: true };
    return text(formatProjectGraphForMcp(name, await changedImpact(project)));
  }
  return { ...text(`unknown tool: ${name}`), isError: true };
}

// Returns a JSON-RPC response object, or null for notifications (no reply expected).
async function handle(pid, msg) {
  if (!msg || msg.jsonrpc !== '2.0') return null;
  const { id: mid, method, params } = msg;
  const isNotification = mid === undefined || mid === null;
  try {
    if (method === 'initialize') return ok(mid, { protocolVersion: params?.protocolVersion || PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'aios-wiki', version: VERSION } });
    if (method === 'tools/list') return ok(mid, { tools: TOOLS });
    if (method === 'tools/call') return ok(mid, await callTool(pid, params?.name, params?.arguments || {}));
    if (method === 'ping') return ok(mid, {});
    if (isNotification) return null; // notifications/initialized, etc.
    return err(mid, -32601, 'method not found: ' + method);
  } catch (e) {
    return isNotification ? null : err(mid, -32603, 'internal error');
  }
}

route('POST', '/mcp/:token', async (req, res, { token }) => {
  const pid = resolveToken(token);
  if (!pid) return json(res, 404, { error: 'unknown mcp token' });
  let body;
  try { body = await readJson(req); } catch { return json(res, 400, err(null, -32700, 'parse error')); }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(pid, m)))).filter(Boolean);
    if (!out.length) { res.writeHead(202); return res.end(); }
    return json(res, 200, out);
  }
  const resp = await handle(pid, body);
  if (resp === null) { res.writeHead(202); return res.end(); } // notification -> 202, no body
  return json(res, 200, resp);
});
// This tool server is request/response only (no server->client streaming); some clients probe GET.
route('GET', '/mcp/:token', (req, res) => { res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' }); res.end(JSON.stringify({ error: 'method not allowed; POST JSON-RPC' })); });

console.log('[aios] mcp wiki server ready (/mcp/:token)');
