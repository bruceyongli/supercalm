import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { db } from './store.js';
import { now } from './util.js';

const execFileP = promisify(execFile);
const GRAPH_VERSION = 1;
const MAX_FILES = Number(process.env.AIOS_PROJECT_GRAPH_MAX_FILES || 4000);
const MAX_PARSE_BYTES = Number(process.env.AIOS_PROJECT_GRAPH_PARSE_BYTES || 600000);
const MAX_FALLBACK_DEPTH = Number(process.env.AIOS_PROJECT_GRAPH_FALLBACK_DEPTH || 8);
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'data', 'dist', 'build', 'coverage', '.next', 'out', '.cache',
  '.venv', 'venv', 'target', 'vendor', '__pycache__',
]);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.css', '.html', '.yml', '.yaml', '.toml', '.lock']);
const MANIFESTS = new Set(['package.json', 'deno.json', 'tsconfig.json', 'jsconfig.json', 'wrangler.jsonc', 'wrangler.toml', 'Makefile', 'justfile', 'go.mod', 'Cargo.toml', 'pyproject.toml']);

db.exec(`
  CREATE TABLE IF NOT EXISTS project_graph_meta (
    project_id      TEXT PRIMARY KEY,
    version         INTEGER NOT NULL,
    status          TEXT NOT NULL,
    root            TEXT,
    indexed_at      INTEGER NOT NULL,
    indexed_head    TEXT,
    file_count      INTEGER NOT NULL DEFAULT 0,
    node_count      INTEGER NOT NULL DEFAULT 0,
    edge_count      INTEGER NOT NULL DEFAULT 0,
    route_count     INTEGER NOT NULL DEFAULT 0,
    agent_count     INTEGER NOT NULL DEFAULT 0,
    mcp_tool_count  INTEGER NOT NULL DEFAULT 0,
    manifest_count  INTEGER NOT NULL DEFAULT 0,
    import_count    INTEGER NOT NULL DEFAULT 0,
    error           TEXT
  );
  CREATE TABLE IF NOT EXISTS project_graph_files (
    project_id  TEXT NOT NULL,
    path        TEXT NOT NULL,
    repo        TEXT,
    kind        TEXT,
    size        INTEGER,
    mtime_ms    INTEGER,
    hash        TEXT,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (project_id, path)
  );
  CREATE TABLE IF NOT EXISTS project_graph_nodes (
    project_id  TEXT NOT NULL,
    id          TEXT NOT NULL,
    type        TEXT NOT NULL,
    label       TEXT,
    path        TEXT,
    confidence  TEXT,
    meta_json   TEXT,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (project_id, id)
  );
  CREATE TABLE IF NOT EXISTS project_graph_edges (
    project_id  TEXT NOT NULL,
    from_id     TEXT NOT NULL,
    to_id       TEXT NOT NULL,
    rel         TEXT NOT NULL,
    confidence  TEXT,
    source      TEXT,
    path        TEXT,
    meta_json   TEXT,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (project_id, from_id, to_id, rel, source)
  );
  CREATE INDEX IF NOT EXISTS idx_project_graph_nodes_type ON project_graph_nodes(project_id, type);
  CREATE INDEX IF NOT EXISTS idx_project_graph_edges_from ON project_graph_edges(project_id, from_id);
  CREATE INDEX IF NOT EXISTS idx_project_graph_edges_to ON project_graph_edges(project_id, to_id);
`);

const _getMeta = db.prepare('SELECT * FROM project_graph_meta WHERE project_id=?');
const _upMeta = db.prepare(`
  INSERT INTO project_graph_meta (
    project_id, version, status, root, indexed_at, indexed_head, file_count, node_count, edge_count,
    route_count, agent_count, mcp_tool_count, manifest_count, import_count, error
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(project_id) DO UPDATE SET
    version=excluded.version, status=excluded.status, root=excluded.root, indexed_at=excluded.indexed_at,
    indexed_head=excluded.indexed_head, file_count=excluded.file_count, node_count=excluded.node_count,
    edge_count=excluded.edge_count, route_count=excluded.route_count, agent_count=excluded.agent_count,
    mcp_tool_count=excluded.mcp_tool_count, manifest_count=excluded.manifest_count,
    import_count=excluded.import_count, error=excluded.error
`);
const _delFiles = db.prepare('DELETE FROM project_graph_files WHERE project_id=?');
const _delNodes = db.prepare('DELETE FROM project_graph_nodes WHERE project_id=?');
const _delEdges = db.prepare('DELETE FROM project_graph_edges WHERE project_id=?');
const _insFile = db.prepare('INSERT INTO project_graph_files (project_id,path,repo,kind,size,mtime_ms,hash,updated_at) VALUES (?,?,?,?,?,?,?,?)');
const _insNode = db.prepare('INSERT OR REPLACE INTO project_graph_nodes (project_id,id,type,label,path,confidence,meta_json,updated_at) VALUES (?,?,?,?,?,?,?,?)');
const _insEdge = db.prepare('INSERT OR REPLACE INTO project_graph_edges (project_id,from_id,to_id,rel,confidence,source,path,meta_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
const _nodes = db.prepare('SELECT * FROM project_graph_nodes WHERE project_id=? ORDER BY type,path,label LIMIT ?');
const _edges = db.prepare('SELECT * FROM project_graph_edges WHERE project_id=? ORDER BY rel,source LIMIT ?');
const _allNodes = db.prepare('SELECT * FROM project_graph_nodes WHERE project_id=?');
const _allEdges = db.prepare('SELECT * FROM project_graph_edges WHERE project_id=?');
const _countsByType = db.prepare('SELECT type, COUNT(*) n FROM project_graph_nodes WHERE project_id=? GROUP BY type ORDER BY type');

const j = (v) => JSON.stringify(v || {});
const parseJ = (s, d = {}) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const slash = (p) => String(p || '').split(/[\\/]+/).filter(Boolean).join('/');
const fileId = (p) => `file:${slash(p)}`;
const routeId = (method, path) => `route:${method}:${path}`;
const mcpId = (name) => `mcp_tool:${name}`;
const agentId = (id) => `agent:${id}`;
const manifestId = (path) => `manifest:${slash(path)}`;
const configId = (name) => `config:${name}`;
const serviceId = (name) => `service:${name}`;
const deployId = (name) => `deploy:${slash(name)}`;
const sessionMetaId = (name) => `session_meta:${name}`;

function cleanProjectPath(path) {
  return normalize(String(path || ''));
}

async function git(cwd, args, { maxBuffer = 4_000_000, timeout = 5000 } = {}) {
  const r = await execFileP('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer, timeout, killSignal: 'SIGKILL' });
  return String(r.stdout || '');
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

function parseGitStatus(out) {
  const rows = String(out || '').split('\0').filter(Boolean);
  const changed = [];
  let head = '';
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.startsWith('# branch.oid ')) {
      const oid = row.slice(13).trim();
      head = oid === '(initial)' ? '' : oid;
      continue;
    }
    const kind = row[0];
    if (!['1', '2', 'u', '?'].includes(kind)) continue;
    const fields = row.split(' ');
    const pathAt = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : 1;
    const path = fields.slice(pathAt).join(' ');
    if (path) changed.push({ path, status: kind === '?' ? '??' : fields[1] || kind });
    if (kind === '2' && rows[i + 1] && !/^[#12u?!] /.test(rows[i + 1])) i++; // original rename path
  }
  return { head, changed };
}

async function inspectRepo(cwd, { changes = false } = {}) {
  if (changes) {
    try {
      const out = await git(cwd, ['status', '--porcelain=v2', '--branch', '-z'], { timeout: 2500, maxBuffer: 2_000_000 });
      return parseGitStatus(out);
    } catch { return null; } // status already handles unborn repositories; never pay a duplicate timeout
  }
  try {
    const out = await git(cwd, ['rev-parse', '--is-inside-work-tree', 'HEAD'], { maxBuffer: 128000, timeout: 1500 });
    const lines = out.trim().split(/\s+/);
    return lines[0] === 'true' ? { head: lines[1] || '', changed: [] } : null;
  } catch {
    // An unborn repository has no HEAD yet, but `git status` still succeeds and identifies it.
    try {
      const out = await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'], { timeout: 1500, maxBuffer: 128000 });
      return parseGitStatus(out);
    } catch { return null; }
  }
}

async function discoverRepos(root, { changes = false } = {}) {
  const rootState = await inspectRepo(root, { changes });
  if (rootState) return [{ prefix: '', cwd: root, name: '.', ...rootState }];
  let kids = [];
  try { kids = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const candidates = kids.filter((x) => x.isDirectory() && !x.name.startsWith('.')).slice(0, 80);
  const inspected = await mapLimit(candidates, 8, async (d) => {
    const cwd = join(root, d.name);
    const state = await inspectRepo(cwd, { changes });
    return state ? { prefix: d.name, cwd, name: d.name, ...state } : null;
  });
  return inspected.filter(Boolean);
}

async function repoFiles(repo) {
  const out = await git(repo.cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { timeout: 6000, maxBuffer: 12_000_000 }).catch(() => '');
  return out.split('\0').filter(Boolean).map((p) => ({
    repo: repo.name,
    rel: slash(repo.prefix ? `${repo.prefix}/${p}` : p),
    abs: join(repo.cwd, p),
  }));
}

async function fallbackFiles(root) {
  const out = [];
  async function walk(dir, rel, depth) {
    if (out.length >= MAX_FILES || depth > MAX_FALLBACK_DEPTH) return;
    let rows = [];
    try { rows = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of rows) {
      if (out.length >= MAX_FILES) return;
      if (ent.name.startsWith('.') && ent.name !== '.env') continue;
      const r = slash(rel ? `${rel}/${ent.name}` : ent.name);
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) await walk(abs, r, depth + 1);
      } else if (ent.isFile()) {
        out.push({ repo: '', rel: r, abs });
      }
    }
  }
  await walk(root, '', 0);
  return out;
}

function fileKind(path) {
  const base = path.split('/').pop();
  if (MANIFESTS.has(base)) return 'manifest';
  const ext = extname(path).toLowerCase();
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) return 'code';
  if (['.md', '.mdx', '.txt'].includes(ext)) return 'doc';
  if (['.json', '.toml', '.yaml', '.yml', '.ini', '.conf', '.env'].includes(ext)) return 'config';
  if (['.css', '.html', '.svg'].includes(ext)) return 'asset';
  return 'other';
}

function shouldParse(path, size) {
  if (size > MAX_PARSE_BYTES) return false;
  const ext = extname(path).toLowerCase();
  return TEXT_EXT.has(ext) || MANIFESTS.has(path.split('/').pop());
}

function isRuntimeSource(path) {
  return /^src\/.+\.[cm]?[jt]sx?$/.test(slash(path));
}

function hashBuf(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

function resolveImport(fromPath, spec, allPaths) {
  if (!spec.startsWith('.')) return null;
  const base = slash(join(dirname(fromPath), spec));
  const candidates = [
    base,
    `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`, `${base}.tsx`, `${base}.jsx`,
    `${base}/index.js`, `${base}/index.mjs`, `${base}/index.ts`, `${base}/index.tsx`,
  ].map(slash);
  return candidates.find((p) => allPaths.has(p)) || null;
}

function parseRoutes(text) {
  const out = [];
  const rx = /\broute\s*\(\s*['"]([A-Z]+)['"]\s*,\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(rx)) out.push({ method: m[1], path: m[2] });
  return out;
}

function parseImports(text) {
  const out = [];
  const rx = /^\s*import(?:\s+[^'";]+?\s+from\s*)?\s*['"]([^'"]+)['"]/gm;
  for (const m of text.matchAll(rx)) out.push(m[1]);
  return out;
}

function parseMcpTools(text) {
  const out = [];
  const rx = /\{\s*name:\s*['"]([^'"]+)['"][\s\S]*?description:\s*(['"`])([\s\S]*?)\2[\s\S]*?\}/g;
  for (const m of text.matchAll(rx)) out.push({ name: m[1], description: m[3].replace(/\s+/g, ' ').trim().slice(0, 240) });
  return out;
}

function parseConfigExports(text) {
  const out = [];
  const rx = /^export\s+const\s+([A-Z][A-Z0-9_]*)\s*=/gm;
  for (const m of text.matchAll(rx)) out.push(m[1]);
  return [...new Set(out)].sort();
}

function exportObjectBody(text, name) {
  const rx = new RegExp(`^export\\s+const\\s+${name}\\s*=\\s*\\{`, 'm');
  const m = rx.exec(text);
  if (!m) return '';
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (lineComment) {
      if (c === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === '*' && n === '/') { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return '';
}

function parseAgent(text) {
  const metaBody = exportObjectBody(text, 'meta');
  const meta = metaBody.match(/\bid\s*:\s*['"]([^'"]+)['"][\s\S]*?\bname\s*:\s*['"]([^'"]+)['"]/);
  if (!meta) return null;
  const actions = [];
  const body = exportObjectBody(text, 'actions');
  if (body) {
    const rx = /^  (?:async\s+)?(?:['"]([^'"]+)['"]|([A-Za-z_][A-Za-z0-9_-]*))\s*\(/gm;
    for (const m of body.matchAll(rx)) actions.push(m[1] || m[2]);
  }
  return { id: meta[1], name: meta[2], actions: [...new Set(actions)].slice(0, 40) };
}

function parseToolServices(text) {
  const body = exportObjectBody(text, 'TOOLS');
  if (!body) return [];
  const out = [];
  const rx = /^  ([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*\{/gm;
  for (const m of body.matchAll(rx)) out.push(m[1]);
  return [...new Set(out)].sort();
}

function parseSessionSchema(text) {
  const m = text.match(/CREATE TABLE IF NOT EXISTS sessions\s*\(([\s\S]*?)\n\s*\);/);
  if (!m) return null;
  const columns = [];
  for (const raw of m[1].split('\n')) {
    const line = raw.trim().replace(/,$/, '');
    if (!line || line.startsWith('--')) continue;
    const name = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+/)?.[1];
    if (name && !['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK'].includes(name.toUpperCase())) columns.push(name);
  }
  const mig = text.match(/for\s*\(\s*const\s+col\s+of\s+\[([\s\S]*?)\]\s*\)/);
  if (mig) {
    const rx = /['"]([a-zA-Z_][a-zA-Z0-9_]*)\s+[^'"]+['"]/g;
    for (const mm of mig[1].matchAll(rx)) if (!columns.includes(mm[1])) columns.push(mm[1]);
  }
  return columns.length ? { table: 'sessions', columns } : null;
}

async function readTrackedFile(f) {
  const st = await stat(f.abs);
  const buf = await readFile(f.abs);
  return { ...f, size: st.size, mtime_ms: Math.round(st.mtimeMs), hash: hashBuf(buf), text: shouldParse(f.rel, st.size) ? buf.toString('utf8') : '' };
}

function insertNode(pid, n, t) {
  _insNode.run(pid, n.id, n.type, n.label || '', n.path || null, n.confidence || 'fact', j(n.meta), t);
}

function insertEdge(pid, e, t) {
  _insEdge.run(pid, e.from, e.to, e.rel, e.confidence || 'fact', e.source || e.rel, e.path || null, j(e.meta), t);
}

async function currentProjectState(project) {
  const root = cleanProjectPath(project.path);
  const repos = await discoverRepos(root, { changes: true });
  const changed = [];
  for (const repo of repos) {
    for (const row of repo.changed || []) changed.push({
      path: slash(repo.prefix ? `${repo.prefix}/${row.path}` : row.path),
      status: row.status,
    });
  }
  const head = repos.length
    ? repos.map((r) => `${r.name}:${r.head || 'unknown'}`).join(',')
    : 'no-git';
  return { head, repos: repos.map((r) => ({ name: r.name, prefix: r.prefix, head: r.head })), changed };
}

function staleness(meta, state) {
  if (!meta) return { indexed: false, stale: true, reasons: ['not-indexed'], dirty: state.changed.length > 0, current_head: state.head, indexed_head: null, changed: state.changed };
  const reasons = [];
  if (meta.version !== GRAPH_VERSION) reasons.push('schema-version');
  if (meta.indexed_head !== state.head) reasons.push('head-changed');
  if (state.changed.length) reasons.push('working-tree-changed');
  return { indexed: true, stale: reasons.length > 0, reasons, dirty: state.changed.length > 0, current_head: state.head, indexed_head: meta.indexed_head, changed: state.changed };
}

export async function rebuildProjectGraph(project) {
  if (!project?.id || !project?.path) throw new Error('project required');
  const root = cleanProjectPath(project.path);
  const t = now();
  try {
    const repos = await discoverRepos(root);
    const listed = repos.length ? (await Promise.all(repos.map(repoFiles))).flat() : await fallbackFiles(root);
    const files = listed.slice(0, MAX_FILES);
    const allPaths = new Set(files.map((f) => f.rel));
    const read = [];
    for (const f of files) {
      try { read.push(await readTrackedFile(f)); } catch { /* deleted or unreadable between ls + read */ }
    }
    const nodes = [];
    const edges = [];
    const addNode = (n) => nodes.push(n);
    const addEdge = (e) => edges.push(e);
    for (const f of read) {
      const fid = fileId(f.rel);
      const kind = fileKind(f.rel);
      addNode({ id: fid, type: 'file', label: f.rel, path: f.rel, confidence: 'fact', meta: { kind, repo: f.repo, size: f.size, hash: f.hash } });
      if (kind === 'manifest') {
        const mid = manifestId(f.rel);
        addNode({ id: mid, type: 'manifest', label: f.rel, path: f.rel, confidence: 'fact', meta: { kind: f.rel.split('/').pop() } });
        addEdge({ from: fid, to: mid, rel: 'defines', confidence: 'fact', source: 'manifest', path: f.rel });
        if (f.rel === 'package.json' && f.text) {
          const pkg = parseJ(f.text);
          if (pkg.version) {
            const did = deployId('package-version');
            addNode({ id: did, type: 'deploy', label: `package version ${pkg.version}`, path: f.rel, confidence: 'fact', meta: { kind: 'release-version', version: pkg.version } });
            addEdge({ from: fid, to: did, rel: 'defines', confidence: 'fact', source: 'package-version', path: f.rel });
          }
        }
      }
      if (f.rel === 'bin/deploy' || f.rel === 'bin/version') {
        const did = deployId(f.rel);
        addNode({ id: did, type: 'deploy', label: f.rel, path: f.rel, confidence: 'fact', meta: { kind: f.rel === 'bin/deploy' ? 'deploy-script' : 'version-script' } });
        addEdge({ from: fid, to: did, rel: 'defines', confidence: 'fact', source: 'deploy-script', path: f.rel });
      }
      if (!f.text) continue;
      if (f.rel === 'src/config.js') {
        for (const name of parseConfigExports(f.text)) {
          const cid = configId(name);
          addNode({ id: cid, type: 'config', label: name, path: f.rel, confidence: 'fact', meta: { export: name } });
          addEdge({ from: fid, to: cid, rel: 'defines', confidence: 'fact', source: 'config-export', path: f.rel });
        }
        for (const name of parseToolServices(f.text)) {
          const sid = serviceId(`tool:${name}`);
          addNode({ id: sid, type: 'service', label: `tool ${name}`, path: f.rel, confidence: 'fact', meta: { kind: 'launch-tool', id: name } });
          addEdge({ from: fid, to: sid, rel: 'defines', confidence: 'fact', source: 'tool-config', path: f.rel });
        }
      }
      if (f.rel === 'src/store.js') {
        const schema = parseSessionSchema(f.text);
        if (schema) {
          const sid = sessionMetaId('sessions');
          addNode({ id: sid, type: 'session_meta', label: 'sessions table', path: f.rel, confidence: 'fact', meta: schema });
          addEdge({ from: fid, to: sid, rel: 'defines', confidence: 'fact', source: 'sqlite-schema', path: f.rel });
        }
      }
      if (isRuntimeSource(f.rel)) {
        for (const r of parseRoutes(f.text)) {
          const rid = routeId(r.method, r.path);
          addNode({ id: rid, type: 'route', label: `${r.method} ${r.path}`, path: f.rel, confidence: 'fact', meta: r });
          addEdge({ from: fid, to: rid, rel: 'defines', confidence: 'fact', source: 'route-literal', path: f.rel });
        }
      }
      if (f.rel.endsWith('src/mcp.js')) {
        for (const tool of parseMcpTools(f.text)) {
          const tid = mcpId(tool.name);
          addNode({ id: tid, type: 'mcp_tool', label: tool.name, path: f.rel, confidence: 'fact', meta: tool });
          addEdge({ from: fid, to: tid, rel: 'defines', confidence: 'fact', source: 'mcp-tool-literal', path: f.rel });
        }
      }
      if (/^src\/agents\/[^/]+\.js$/.test(f.rel)) {
        const a = parseAgent(f.text);
        if (a) {
          const aid = agentId(a.id);
          addNode({ id: aid, type: 'agent', label: a.name || a.id, path: f.rel, confidence: 'fact', meta: { id: a.id, actions: a.actions } });
          addEdge({ from: fid, to: aid, rel: 'defines', confidence: 'fact', source: 'agent-meta', path: f.rel });
        }
      }
      for (const spec of parseImports(f.text)) {
        const target = resolveImport(f.rel, spec, allPaths);
        if (target) addEdge({ from: fid, to: fileId(target), rel: 'imports', confidence: 'declared', source: 'static-import', path: f.rel, meta: { spec } });
      }
    }
    const state = await currentProjectState(project);
    const head = state.head;
    db.exec('BEGIN');
    try {
      _delEdges.run(project.id); _delNodes.run(project.id); _delFiles.run(project.id);
      for (const f of read) _insFile.run(project.id, f.rel, f.repo || null, fileKind(f.rel), f.size, f.mtime_ms, f.hash, t);
      for (const n of nodes) insertNode(project.id, n, t);
      for (const e of edges) insertEdge(project.id, e, t);
      const count = (type) => nodes.filter((n) => n.type === type).length;
      _upMeta.run(project.id, GRAPH_VERSION, 'ready', root, t, head, read.length, nodes.length, edges.length, count('route'), count('agent'), count('mcp_tool'), count('manifest'), edges.filter((e) => e.rel === 'imports').length, null);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return projectGraphSummary(project);
  } catch (e) {
    _upMeta.run(project.id, GRAPH_VERSION, 'error', root, t, null, 0, 0, 0, 0, 0, 0, 0, 0, String(e.message || e).slice(0, 500));
    throw e;
  }
}

export async function projectGraphSummary(project) {
  const meta = _getMeta.get(project.id) || null;
  const state = await currentProjectState(project).catch(() => ({ head: null, changed: [], repos: [] }));
  const counts = Object.fromEntries(_countsByType.all(project.id).map((r) => [r.type, r.n]));
  return {
    ok: !!meta && meta.status === 'ready',
    meta,
    counts,
    staleness: staleness(meta, state),
  };
}

export async function projectGraphSnapshot(project, { nodeLimit = 200, edgeLimit = 400 } = {}) {
  const summary = await projectGraphSummary(project);
  return {
    ...summary,
    nodes: _nodes.all(project.id, nodeLimit).map((n) => ({ ...n, extracted_at: n.updated_at, meta: parseJ(n.meta_json) })),
    edges: _edges.all(project.id, edgeLimit).map((e) => ({ ...e, extracted_at: e.updated_at, meta: parseJ(e.meta_json) })),
  };
}

function impactedSurfaces(pid, changed) {
  const nodes = _allNodes.all(pid).map((n) => ({ ...n, meta: parseJ(n.meta_json) }));
  const edges = _allEdges.all(pid).map((e) => ({ ...e, meta: parseJ(e.meta_json) }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const reverseImports = new Map();
  const defines = new Map();
  for (const e of edges) {
    if (e.rel === 'imports') {
      const arr = reverseImports.get(e.to_id) || [];
      arr.push(e.from_id);
      reverseImports.set(e.to_id, arr);
    }
    if (e.rel === 'defines') {
      const arr = defines.get(e.from_id) || [];
      arr.push(e);
      defines.set(e.from_id, arr);
    }
  }
  const changedIds = changed.map((c) => fileId(c.path));
  const queue = changedIds.map((id) => ({ id, depth: 0, via: id }));
  const seen = new Map(queue.map((q) => [q.id, q]));
  while (queue.length) {
    const cur = queue.shift();
    if (cur.depth >= 3) continue;
    for (const importer of reverseImports.get(cur.id) || []) {
      if (seen.has(importer)) continue;
      const next = { id: importer, depth: cur.depth + 1, via: cur.via };
      seen.set(importer, next);
      queue.push(next);
    }
  }
  const surfaces = [];
  for (const hit of seen.values()) {
    const f = nodeById.get(hit.id);
    for (const e of defines.get(hit.id) || []) {
      const n = nodeById.get(e.to_id);
      if (!n || n.type === 'file') continue;
      surfaces.push({
        id: n.id,
        type: n.type,
        label: n.label,
        path: n.path,
        confidence: hit.depth ? 'declared' : e.confidence || 'fact',
        reason: hit.depth ? `imports changed ${nodeById.get(hit.via)?.path || hit.via}` : 'defined in changed file',
        depth: hit.depth,
        extracted_at: n.updated_at,
      });
    }
  }
  const byId = new Map();
  for (const s of surfaces) {
    const prev = byId.get(s.id);
    if (!prev || s.depth < prev.depth) byId.set(s.id, s);
  }
  return [...byId.values()].sort((a, b) => a.depth - b.depth || a.type.localeCompare(b.type) || a.label.localeCompare(b.label)).slice(0, 80);
}

export async function changedImpact(project) {
  const summary = await projectGraphSummary(project);
  const changed = summary.staleness.changed || [];
  if (!summary.ok) return { ok: false, reason: 'not-indexed', summary, changed_files: changed, affected: [] };
  const affected = impactedSurfaces(project.id, changed);
  const grouped = {};
  for (const s of affected) {
    const key = `${s.type}s`;
    (grouped[key] ||= []).push(s);
  }
  return {
    ok: true,
    summary,
    stale: summary.staleness.stale,
    staleness: summary.staleness,
    changed_files: changed,
    affected,
    grouped,
    note: changed.length ? 'Affected surfaces are direct definitions plus reverse static-import dependents, capped at depth 3.' : 'No working-tree changes detected.',
  };
}

export async function projectGraphBrief(project) {
  const summary = await projectGraphSummary(project);
  if (!summary.ok) return { status: 'not-indexed', stale: true, counts: summary.counts || {}, reason: summary.meta?.error || 'no project graph index' };
  const impact = await changedImpact(project);
  return {
    status: 'ready',
    indexed_at: summary.meta.indexed_at,
    indexed_head: summary.meta.indexed_head,
    stale: summary.staleness.stale,
    stale_reasons: summary.staleness.reasons,
    counts: summary.counts,
    changed_files: impact.changed_files.slice(0, 20),
    affected_surfaces: impact.affected.slice(0, 20).map((s) => ({ type: s.type, label: s.label, confidence: s.confidence, reason: s.reason, extracted_at: s.extracted_at })),
  };
}

export function formatProjectGraphForMcp(name, payload) {
  if (!payload?.ok && payload?.reason === 'not-indexed') return 'project_graph is not indexed yet. Ask the operator to run /api/project/:id/graph/rebuild or use the Supercalm Project Graph rebuild action.';
  if (name === 'changed_impact') {
    const lines = [
      `stale: ${payload.stale ? 'yes' : 'no'}${payload.staleness?.reasons?.length ? ' (' + payload.staleness.reasons.join(', ') + ')' : ''}`,
      `changed files: ${payload.changed_files.length}`,
      ...payload.changed_files.slice(0, 25).map((f) => `- ${f.status || '?'} ${f.path}`),
      '',
      `affected surfaces: ${payload.affected.length}`,
      ...payload.affected.slice(0, 50).map((s) => `- [${s.confidence}] ${s.type}: ${s.label}${s.reason ? ' - ' + s.reason : ''}`),
    ];
    return lines.join('\n').trim();
  }
  const s = payload;
  return [
    `status: ${s.ok ? 'ready' : s.meta?.status || 'missing'}`,
    `stale: ${s.staleness?.stale ? 'yes' : 'no'}${s.staleness?.reasons?.length ? ' (' + s.staleness.reasons.join(', ') + ')' : ''}`,
    `indexed_head: ${s.meta?.indexed_head || '(none)'}`,
    `current_head: ${s.staleness?.current_head || '(unknown)'}`,
    `counts: ${Object.entries(s.counts || {}).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`,
  ].join('\n');
}
