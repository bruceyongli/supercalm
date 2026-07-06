import { route, json } from './server.js';
import { getProject } from './store.js';
import { changedImpact, projectGraphSnapshot, projectGraphSummary, rebuildProjectGraph } from './project_graph_core.js';

function projectOr404(res, pid) {
  const project = getProject(pid);
  if (!project) {
    json(res, 404, { error: 'no such project' });
    return null;
  }
  return project;
}

route('GET', '/api/project/:id/graph', async (req, res, { id: pid }, url) => {
  const project = projectOr404(res, pid);
  if (!project) return;
  const detail = url.searchParams.get('detail') === '1';
  const nodeLimit = Math.max(1, Math.min(2000, Number(url.searchParams.get('nodes') || 300)));
  const edgeLimit = Math.max(1, Math.min(5000, Number(url.searchParams.get('edges') || 800)));
  const payload = detail ? await projectGraphSnapshot(project, { nodeLimit, edgeLimit }) : await projectGraphSummary(project);
  json(res, 200, { ok: true, graph: payload });
});

route('POST', '/api/project/:id/graph/rebuild', async (req, res, { id: pid }) => {
  const project = projectOr404(res, pid);
  if (!project) return;
  try {
    json(res, 200, { ok: true, graph: await rebuildProjectGraph(project) });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

route('GET', '/api/project/:id/graph/impact', async (req, res, { id: pid }) => {
  const project = projectOr404(res, pid);
  if (!project) return;
  json(res, 200, { ok: true, impact: await changedImpact(project) });
});

console.log('[aios] project graph ready (/api/project/:id/graph)');
