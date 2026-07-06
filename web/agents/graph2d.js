// 2D "Obsidian galaxy" renderer (canvas via vendored force-graph) — flat SOLID circle nodes (no glow),
// thin edges, force-directed web, pan + zoom (no tilt). Sized by a metric, colored by category, hub
// labels fade in on zoom. Mirrors the mountGraph(...) contract so the map panel can swap renderers.

let libReady = null;
function injectScript(file) {
  return new Promise((resolve, reject) => {
    const elId = 'vendorjs-' + file.replace(/\W/g, '');
    if (document.getElementById(elId)) return resolve();
    const s = document.createElement('script');
    s.id = elId;
    s.src = new URL('vendor/' + file, document.baseURI).href;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('failed to load vendor/' + file));
    document.head.appendChild(s);
  });
}
async function loadLib() {
  if (libReady) return libReady;
  libReady = (async () => {
    if (!window.ForceGraph) await injectScript('force-graph.min.js');
    if (!window.ForceGraph) throw new Error('force-graph failed to load');
    return window.ForceGraph;
  })();
  return libReady;
}

// minimal velocity-based collision (avoids the d3-quadtree dependency) — O(n^2), fine for a few hundred nodes
function collideForce(radius, strength = 0.85) {
  let nodes = [];
  function force() {
    const n = nodes.length;
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      const ra = radius(a);
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = (b.x || 0) - (a.x || 0);
        let dy = (b.y || 0) - (a.y || 0);
        const d2 = dx * dx + dy * dy;
        const min = ra + radius(b);
        if (d2 < min * min && d2 > 0) {
          const dist = Math.sqrt(d2);
          const push = ((min - dist) / dist) * strength * 0.5;
          dx *= push; dy *= push;
          a.vx -= dx; a.vy -= dy;
          b.vx += dx; b.vy += dy;
        }
      }
    }
  }
  force.initialize = (n) => { nodes = n; };
  return force;
}

// repel the MANAGER hubs (request nodes) from each other by a distance that scales with each group's size,
// so groups stay DISTINCT and navigable instead of collapsing into one giant cluster ("dynamic distancing").
function hubRepel(rOf, strength = 0.5, gap = 18) {
  let hubs = [];
  function force() {
    for (let i = 0; i < hubs.length; i++) {
      const a = hubs[i];
      for (let j = i + 1; j < hubs.length; j++) {
        const b = hubs[j];
        let dx = (b.x || 0) - (a.x || 0);
        let dy = (b.y || 0) - (a.y || 0);
        const d2 = dx * dx + dy * dy;
        const md = rOf(a) + rOf(b) + gap;
        if (d2 < md * md && d2 > 0) {
          const dist = Math.sqrt(d2);
          const push = ((md - dist) / dist) * strength * 0.5;
          dx *= push; dy *= push;
          a.vx -= dx; a.vy -= dy;
          b.vx += dx; b.vy += dy;
        }
      }
    }
  }
  force.initialize = (n) => { hubs = n.filter((x) => x.kind === 'system'); };
  return force;
}

const CAT_COLOR = {
  ask: '#8fb3ff', explore: '#4d9be0', research: '#3fd0c4', edit: '#46d16a', exec: '#e0b13a',
  subagent: '#b07cff', decision: '#ff9d4d', plan: '#7c8bff', reason: '#8b97a3', respond: '#aab6c2', other: '#9aa7b4', file: '#6b7682',
};
function hexA(hex, a) {
  const h = String(hex || '#888').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
const slowPulse = () => 0.5 + 0.5 * Math.sin((2 * Math.PI * 0.4 * (Date.now() % 100000)) / 1000); // ~0.4 Hz

export async function mountGraph2d(el, graph, { onSelect } = {}) {
  const FG = await loadLib();
  el.innerHTML = '';
  const nodes = (graph.nodes || []).map((n) => {
    const r = Math.max(1.4, Math.max(1, n.size || 4) * 0.32); // node radius (Obsidian dots are small)
    return {
      id: n.id,
      name: (n.label || n.id).replace(/\n/g, '  '),
      short: (n.short || n.label || n.id).split('\n')[0],
      val: r * r, // force-graph radius = nodeRelSize * sqrt(val)
      _r: r,
      color: n.color || CAT_COLOR[n.category] || CAT_COLOR.other,
      kind: n.kind,
      hub: !!n.hub,
      problem: n.problem,
      pin: !!n.pin,
      blink: n.blink,
    };
  });
  const links = (graph.edges || []).map((e) => ({ source: e.from, target: e.to, core: e.core ? 1 : 0, cross: e.cross ? 1 : 0 }));
  nodes.forEach((n) => { if (n.pin) { n.fx = 0; n.fy = 0; } });
  // parent→children map (built from string-id links BEFORE force-graph mutates them into objects), so a
  // click can zoom to a node's whole subtree — "near it, the subnodes get readable space".
  const kids = new Map();
  const parent = new Map();
  for (const l of links) {
    if (!kids.has(l.source)) kids.set(l.source, []);
    kids.get(l.source).push(l.target);
    parent.set(l.target, l.source);
  }
  const rById = new Map(nodes.map((n) => [n.id, n._r]));
  // each request group's "radius" scales with how much work it contains -> bigger groups get more space
  const descN = (id) => { let c = 0; const st = [...(kids.get(id) || [])]; while (st.length) { c++; const x = st.pop(); for (const k of kids.get(x) || []) st.push(k); } return c; };
  const groupR = new Map(nodes.filter((n) => n.kind === 'system').map((n) => [n.id, 22 + 7 * Math.sqrt(descN(n.id))]));
  function subtree(id) {
    const root = (kids.get(id) || []).length ? id : parent.get(id) || id; // leaf -> its parent's cluster
    const set = new Set([root]);
    const st = [root];
    while (st.length) {
      const x = st.pop();
      for (const c of kids.get(x) || []) if (!set.has(c)) { set.add(c); st.push(c); }
    }
    return set;
  }

  const Graph = FG()(el)
    .backgroundColor('#0e1116')
    .autoPauseRedraw(false) // keep redrawing so the recent-action blink animates after the layout settles
    .graphData({ nodes, links })
    .nodeRelSize(1)
    .nodeVal('val')
    .nodeColor('color')
    .nodeLabel((n) => `<div style="font:11px ui-monospace,Menlo,monospace;color:#cdd9e5;max-width:240px">${escapeHtmlSafe(n.name)}</div>`)
    .linkColor((l) => (l.core ? 'rgba(0,0,0,0)' : l.cross ? 'rgba(150,172,205,0.18)' : 'rgba(170,185,205,0.12)'))
    .linkWidth(0.6)
    .nodeCanvasObjectMode(() => 'after')
    .nodeCanvasObject((n, ctx, scale) => {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return; // not positioned yet
      if (n.glow) { // ONLY the active branch glows (parents of the current work), not every hub
        const k = slowPulse();
        const rr = n._r * (1.7 + 0.6 * k);
        const g = ctx.createRadialGradient(n.x, n.y, n._r * 0.7, n.x, n.y, rr);
        g.addColorStop(0, hexA(n.color, 0));
        g.addColorStop(0.55, hexA(n.color, 0.06 + 0.14 * k));
        g.addColorStop(1, hexA(n.color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(n.x, n.y, rr, 0, 2 * Math.PI);
        ctx.fill();
      }
      if (n.blink != null) { // 5 most-recent actions pulse; rank 0 = newest = fastest
        const freq = 2.3 - n.blink * 0.45;
        const k = 0.5 + 0.5 * Math.sin((2 * Math.PI * freq * (Date.now() % 100000)) / 1000);
        ctx.beginPath();
        ctx.arc(n.x, n.y, n._r + (1 + 3 * k) / scale, 0, 2 * Math.PI);
        ctx.strokeStyle = `rgba(255,255,255,${0.12 + 0.5 * k})`;
        ctx.lineWidth = 1.4 / scale;
        ctx.stroke();
      }
      if (n.problem) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n._r + 1.4, 0, 2 * Math.PI);
        ctx.strokeStyle = 'rgba(248,81,73,0.9)';
        ctx.lineWidth = 1.3 / scale;
        ctx.stroke();
      }
      // labels fade in on zoom (declutter when zoomed out), constant screen size
      const show = n.kind === 'system' ? scale > 0.9 : n.hub ? scale > 2.3 : false;
      if (show && n.short) {
        const fs = (n.kind === 'system' ? 12 : 9) / scale;
        ctx.font = `${fs}px ui-monospace, Menlo, monospace`;
        ctx.fillStyle = n.kind === 'system' ? 'rgba(233,239,246,0.96)' : 'rgba(165,180,196,0.85)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(n.short, n.x, n.y + n._r + 1.5 / scale);
      }
    })
    .onNodeClick((n) => { const set = subtree(n.id); Graph.zoomToFit(600, 36, (node) => set.has(node.id)); onSelect?.(n); })
    .onBackgroundClick(() => onSelect?.(null));

  // Pack groups close but with NO overlap. distanceMax caps repulsion to a LOCAL range (else each group's
  // ~40 satellites repel every other group globally and nothing packs); short strong core links pull groups
  // to the center; forceCollide (radius = node radius + gap) then guarantees nodes never overlap.
  try {
    Graph.d3Force('charge').strength(-14).distanceMax(44);
    Graph.d3Force('link').distance((l) => (l.core ? 46 : l.cross ? 26 : 6)).strength((l) => (l.core ? 0.2 : l.cross ? 0.45 : 1));
    Graph.d3Force('center').strength(1);
    Graph.d3Force('collide', collideForce((n) => (rById.get(n.id) || n._r || 2) + 1.4, 0.9));
    // lighter hub-repel now that shared-file cross-links weave related requests together (community structure)
    Graph.d3Force('hubrepel', hubRepel((n) => groupR.get(n.id) || 30, 0.35, 18));
  } catch {}

  // Fit, then frame the content in the LOWER part of the canvas so the floating top info box doesn't cover
  // it: shrink a touch (margin all around) then pan down so the slack sits at the top. Portrait side-panel
  // gets the full shift; a landscape/expanded frame has less vertical room, so shift less to avoid clipping.
  function fitLower(ms = 500) {
    Graph.zoomToFit(ms, 26);
    setTimeout(() => {
      try {
        const w = el.clientWidth || 600, h = el.clientHeight || 480;
        const frac = h > w ? 0.16 : 0.05;
        Graph.zoom(Graph.zoom() * (1 - frac), 0);
        const c = Graph.centerAt();
        Graph.centerAt(c.x, c.y - (frac * h * 0.5) / (Graph.zoom() || 1), 0);
      } catch {}
    }, ms + 60);
  }
  Graph.cooldownTicks(230);
  let fitted = false;
  Graph.onEngineStop(() => { if (!fitted) { fitted = true; fitLower(500); } });
  const size = () => Graph.width(el.clientWidth || 600).height(el.clientHeight || 480);
  size();

  return {
    destroy() {
      try {
        Graph._destructor && Graph._destructor();
      } catch {}
      el.innerHTML = '';
    },
    fit() {
      try {
        fitLower(500);
      } catch {}
    },
    resize() {
      try {
        size();
        fitLower(500);
      } catch {}
    },
    relayout() {
      try {
        Graph.d3ReheatSimulation();
      } catch {}
    },
    select(id) {
      const n = nodes.find((x) => x.id === id);
      if (n && n.x != null) Graph.centerAt(n.x, n.y, 500);
    },
  };
}

function escapeHtmlSafe(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
