import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-project-graph-data-'));

const execFileP = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'aios-project-graph-repo-'));
const sh = (cmd, args, opts = {}) => execFileP(cmd, args, { cwd: root, encoding: 'utf8', ...opts });

await mkdir(join(root, 'src', 'agents'), { recursive: true });
await mkdir(join(root, 'test'), { recursive: true });
await mkdir(join(root, 'bin'), { recursive: true });
await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.2.3', type: 'module' }, null, 2));
await writeFile(join(root, 'src', 'util.js'), 'export const ok = true;\n');
await writeFile(join(root, 'bin', 'deploy'), '#!/usr/bin/env bash\necho deploy\n');
await writeFile(join(root, 'bin', 'version'), '#!/usr/bin/env bash\necho version\n');
await writeFile(join(root, 'src', 'config.js'), `
export const PORT = Number(process.env.AIOS_PORT || 8793);
export const HOST = process.env.AIOS_HOST || '127.0.0.1';
export const TOOLS = {
  claude: { label: 'Claude Code' },
  codex: { label: 'Codex' },
};
`);
await writeFile(join(root, 'src', 'store.js'), `
db.exec(\`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    tool TEXT NOT NULL,
    status TEXT NOT NULL
  );
\`);
`);
await writeFile(join(root, 'src', 'server.js'), `
import { ok } from './util.js';
route('GET', '/healthz', () => ok);
`);
await writeFile(join(root, 'test', 'route_fixture.test.js'), `
route('DELETE', '/fixture-only', () => {});
`);
await writeFile(join(root, 'src', 'mcp.js'), `
const TOOLS = [
  { name: 'wiki_search', description: 'Search docs.' },
  { name: 'changed_impact', description: 'Show changed impact.' },
];
`);
await writeFile(join(root, 'src', 'agents', 'supervisor.js'), `
export const actions = {
  async run() {},
  async generate() {},
};
export const meta = {
  id: 'supervisor',
  name: 'Supervisor',
};
`);

await sh('git', ['init']);
await sh('git', ['add', '.']);
await sh('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init']);

const store = await import('../src/store.js');
const graph = await import('../src/project_graph_core.js');
const project = store.createProject({ id: 'p_test', name: 'fixture', path: root });
const summary = await graph.rebuildProjectGraph(project);

assert.equal(summary.ok, true);
assert.equal(summary.counts.route, 1);
assert.equal(summary.counts.agent, 1);
assert.equal(summary.counts.mcp_tool, 2);
assert.equal(summary.counts.manifest, 1);
assert.equal(summary.counts.config, 3);
assert.equal(summary.counts.service, 2);
assert.equal(summary.counts.deploy, 3);
assert.equal(summary.counts.session_meta, 1);

const snapshot = await graph.projectGraphSnapshot(project, { nodeLimit: 100, edgeLimit: 100 });
assert(snapshot.nodes.some((n) => n.id === 'route:GET:/healthz'));
assert.equal(snapshot.nodes.some((n) => n.id === 'route:DELETE:/fixture-only'), false);
assert(snapshot.nodes.every((n) => Number.isFinite(n.extracted_at)));
assert(snapshot.edges.every((e) => Number.isFinite(e.extracted_at)));
assert(snapshot.nodes.some((n) => n.id === 'agent:supervisor' && n.meta.actions.includes('run')));
assert(snapshot.nodes.some((n) => n.id === 'mcp_tool:changed_impact'));
assert(snapshot.nodes.some((n) => n.id === 'config:PORT' && n.confidence === 'fact'));
assert(snapshot.nodes.some((n) => n.id === 'service:tool:codex' && n.confidence === 'fact'));
assert(snapshot.nodes.some((n) => n.id === 'deploy:package-version' && n.meta.version === '1.2.3'));
assert(snapshot.nodes.some((n) => n.id === 'session_meta:sessions' && n.meta.columns.includes('status')));
assert(snapshot.edges.some((e) => e.rel === 'imports' && e.from_id === 'file:src/server.js' && e.to_id === 'file:src/util.js' && e.confidence === 'declared'));

await writeFile(join(root, 'src', 'server.js'), `
import { ok } from './util.js';
route('GET', '/healthz', () => ok);
route('POST', '/api/new', () => ok);
`);
const impact = await graph.changedImpact(project);
assert.equal(impact.ok, true);
assert.equal(impact.stale, true);
assert(impact.changed_files.some((f) => f.path === 'src/server.js'));
assert(impact.affected.some((s) => s.id === 'route:GET:/healthz' && s.confidence === 'fact'));
assert(impact.affected.some((s) => s.id === 'route:GET:/healthz' && Number.isFinite(s.extracted_at)));

console.log('project_graph.test ok');
