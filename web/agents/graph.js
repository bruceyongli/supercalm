// Shared visual-graph renderer for map agents. One Cytoscape canvas (pan/zoom, tap-node → detail)
// that any map *source* feeds with a standard graph: { nodes:[{id,label,kind,status?,detail?,parent?}],
// edges:[{from,to,label?}], layout? }. Layout defaults to fcose — a force-directed embedder that
// MINIMIZES EDGE LENGTH and tiles leaf nodes, so related nodes cluster tightly (the knowledge-map
// technique we want). Falls back to Cytoscape's built-in cose if the fcose plugin can't load.

let ready = null; // Promise<cytoscape>
let hasFcose = false;

// Vendored UMD bundles set window globals reliably when injected as classic <script> tags (a bare
// dynamic import() of a webpack-UMD bundle does not always assign the global), so load them that way.
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

function loadCytoscape() {
  if (ready) return ready;
  ready = (async () => {
    if (!window.cytoscape) await injectScript('cytoscape.min.js');
    if (!window.cytoscape) throw new Error('cytoscape failed to load');
    try {
      if (!window.layoutBase) await injectScript('layout-base.js');
      if (!window.coseBase) await injectScript('cose-base.js');
      if (!window.cytoscapeFcose) await injectScript('cytoscape-fcose.js');
      if (window.cytoscapeFcose) {
        window.cytoscape.use(window.cytoscapeFcose);
        hasFcose = true;
      }
    } catch (e) {
      console.warn('[aios] fcose layout unavailable; using built-in cose —', e.message);
    }
    return window.cytoscape;
  })();
  return ready;
}

// Causal-graph encoding: shape = role (what kind of thing), border = state (status), a dashed border
// = a claimed-but-unverified outcome, and a bright halo = a decision waiting on the human. Edge color
// = relation (blocks/threatens are red, produced/resolves green, raised yellow). The most important
// variables (status + "needs you") get the strongest visual channels.
const STYLE = [
  {
    selector: 'node',
    style: {
      'background-color': '#1b2129',
      'border-color': '#30363d',
      'border-width': 1.5,
      label: 'data(label)',
      color: '#c9d1d9',
      'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
      'font-size': 10,
      'text-wrap': 'wrap',
      'text-max-width': 124,
      'text-valign': 'center',
      'text-halign': 'center',
      shape: 'round-rectangle',
      width: 'label',
      height: 'label',
      padding: 9,
    },
  },
  // role -> shape + background tint (legacy v1 kinds kept so old maps still render)
  { selector: 'node[role="ask"]', style: { shape: 'round-rectangle', 'background-color': '#16273f', color: '#cfe3ff', 'border-width': 2, 'border-color': '#3b69a8', 'font-size': 11, 'text-max-width': 150 } },
  { selector: 'node[role="action"]', style: { shape: 'round-rectangle', 'background-color': '#1b2129' } },
  { selector: 'node[role="outcome"]', style: { shape: 'round-rectangle', 'background-color': '#0e1c13' } },
  { selector: 'node[role="problem"]', style: { shape: 'diamond', 'background-color': '#2a0f12', padding: 12 } },
  { selector: 'node[role="decision"]', style: { shape: 'hexagon', 'background-color': '#2a1d07', padding: 12 } },
  { selector: 'node[kind="session"]', style: { 'background-color': '#13233a', 'border-color': '#58a6ff', 'border-width': 2, 'font-size': 11, color: '#cfe3ff' } },
  { selector: 'node[kind="decision"]', style: { 'background-color': '#2a1d07' } },
  { selector: 'node[kind="risk"]', style: { 'background-color': '#2a0f12' } },
  { selector: 'node[kind="artifact"]', style: { 'background-color': '#0e1c13' } },
  // state -> border color (the status channel)
  { selector: 'node[state="done"]', style: { 'border-color': '#3fb950' } },
  { selector: 'node[state="active"]', style: { 'border-color': '#58a6ff' } },
  { selector: 'node[state="blocked"]', style: { 'border-color': '#f85149' } },
  { selector: 'node[state="open"]', style: { 'border-color': '#d29922' } },
  { selector: 'node[state="resolved"]', style: { 'border-color': '#444c56', opacity: 0.78 } },
  { selector: 'node[state="pending"]', style: { 'border-color': '#6e7681' } },
  { selector: 'node[status="done"]', style: { 'border-color': '#3fb950' } },
  { selector: 'node[status="active"]', style: { 'border-color': '#d29922' } },
  { selector: 'node[status="blocked"]', style: { 'border-color': '#f85149' } },
  // claimed-but-unverified outcome -> dashed border (trust signal)
  { selector: 'node[role="outcome"][evidence="claimed"]', style: { 'border-style': 'dashed' } },
  // a decision waiting on the human -> bright halo + emphasis (the highest-value node)
  { selector: 'node[?needs_human]', style: { 'border-width': 4, 'border-color': '#ffa657', 'underlay-color': '#ffa657', 'underlay-opacity': 0.22, 'underlay-padding': 10, 'font-size': 11, color: '#fff', 'z-index': 99 } },
  // "you are here" — the request/step happening right now. Bright cyan ring so the eye lands on it first.
  { selector: 'node.active-now', style: { 'border-width': 4, 'border-color': '#58d3ff', 'underlay-color': '#58d3ff', 'underlay-opacity': 0.3, 'underlay-padding': 13, color: '#fff', 'z-index': 100 } },
  { selector: 'node.faded', style: { opacity: 0.14 } },
  { selector: 'node:selected', style: { 'border-width': 3.5, 'border-color': '#58a6ff', color: '#fff' } },
  // --- session-space (anatomy / solar-system) nodes: size by data(diam), shape by kind, color by category ---
  { selector: 'node[diam]', style: { width: 'data(diam)', height: 'data(diam)', 'font-size': 9, padding: 2 } },
  // request node: width encodes cost (data(diam)); height grows to FIT the full request text at a readable size
  { selector: 'node[kind="system"]', style: { shape: 'round-rectangle', height: 'label', 'background-color': '#16273f', 'border-color': '#3b69a8', 'border-width': 2, color: '#eaf2ff', 'font-size': 13, 'font-weight': 600, 'text-max-width': 'data(tmw)', 'text-wrap': 'wrap', 'text-valign': 'center', 'text-halign': 'center', 'line-height': 1.18, padding: 9 } },
  { selector: 'node[kind="cluster"]', style: { shape: 'ellipse', 'border-width': 1.5, color: '#dfe7ef', 'font-size': 10, 'text-max-width': 'data(tmw)' } },
  { selector: 'node[kind="turn"]', style: { shape: 'ellipse', 'border-width': 1, 'font-size': 8, color: '#9aa7b4' } },
  { selector: 'node[category="explore"]', style: { 'background-color': '#13314a', 'border-color': '#3d7ab0' } },
  { selector: 'node[category="research"]', style: { 'background-color': '#0e2a2a', 'border-color': '#39c5bb' } },
  { selector: 'node[category="edit"]', style: { 'background-color': '#0e2a1a', 'border-color': '#3fb950' } },
  { selector: 'node[category="exec"]', style: { 'background-color': '#2a230c', 'border-color': '#d2a022' } },
  { selector: 'node[category="subagent"]', style: { 'background-color': '#241640', 'border-color': '#a371f7' } },
  { selector: 'node[category="decision"]', style: { 'background-color': '#3a2207', 'border-color': '#ffa657' } },
  { selector: 'node[category="plan"]', style: { 'background-color': '#1c2233', 'border-color': '#6e7aff' } },
  { selector: 'node[category="reason"]', style: { 'background-color': '#191f27', 'border-color': '#444c56', color: '#7d8590' } },
  { selector: 'node[category="respond"]', style: { 'background-color': '#161b22', 'border-color': '#444c56', color: '#8b949e' } },
  { selector: 'node[problem="1"]', style: { 'border-color': '#f85149', 'border-width': 3 } },
  { selector: 'edge[hier="1"]', style: { 'line-color': '#2c3440', 'target-arrow-shape': 'none', width: 1, opacity: 0.6 } },
  {
    selector: 'edge',
    style: {
      width: 1.4,
      'line-color': '#30363d',
      'target-arrow-color': '#30363d',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.8,
      'curve-style': 'bezier',
      label: 'data(label)',
      'font-size': 7,
      color: '#6e7681',
      'text-rotation': 'autorotate',
      'text-background-color': '#0d1117',
      'text-background-opacity': 0.85,
      'text-background-padding': 1.5,
    },
  },
  { selector: 'edge[rel="produced"]', style: { 'line-color': '#2ea043', 'target-arrow-color': '#2ea043' } },
  { selector: 'edge[rel="resolves"]', style: { 'line-color': '#2ea043', 'target-arrow-color': '#2ea043', 'line-style': 'dashed' } },
  { selector: 'edge[rel="raised"]', style: { 'line-color': '#d29922', 'target-arrow-color': '#d29922' } },
  { selector: 'edge[rel="blocks"]', style: { 'line-color': '#f85149', 'target-arrow-color': '#f85149', 'line-style': 'dashed', width: 1.8 } },
  { selector: 'edge[rel="threatens"]', style: { 'line-color': '#f85149', 'target-arrow-color': '#f85149', 'line-style': 'dotted' } },
  // the request spine (ask -> ask) — the backbone the whole story hangs on; brighter + thicker.
  { selector: 'edge.spine', style: { 'line-color': '#3b69a8', 'target-arrow-color': '#3b69a8', width: 2.6, 'arrow-scale': 1 } },
  // Flow backbone: request -> request in chronological order, DIRECTED + labeled/colored by the RELATION
  // (the real session flow: follow-up / rework / scope-change / aside). This is what connects the requests
  // into one timeline-web instead of disconnected islands.
  { selector: 'edge[flow="1"]', style: { 'line-color': '#4b6da8', 'target-arrow-color': '#4b6da8', 'target-arrow-shape': 'triangle', 'arrow-scale': 1.15, width: 2.6, 'curve-style': 'bezier', label: 'data(label)', 'font-size': 8, color: '#aab6c2', 'text-rotation': 'autorotate', 'text-background-color': '#0d1117', 'text-background-opacity': 0.9, 'text-background-padding': 2, 'z-index': 50 } },
  { selector: 'edge[flow="1"][rel="follow-up"]', style: { 'line-color': '#39c5bb', 'target-arrow-color': '#39c5bb' } },
  { selector: 'edge[flow="1"][rel="rework"]', style: { 'line-color': '#ffa657', 'target-arrow-color': '#ffa657', 'line-style': 'dashed', width: 3 } },
  { selector: 'edge[flow="1"][rel="scope-change"]', style: { 'line-color': '#a371f7', 'target-arrow-color': '#a371f7', width: 3 } },
  { selector: 'edge[flow="1"][rel="aside"]', style: { 'line-color': '#58a6ff', 'target-arrow-color': '#58a6ff', 'line-style': 'dotted' } },
  // ---- Tree view: session theme (root) → feature → task → [expand] request → cluster ----
  { selector: 'node[kind="root"]', style: { shape: 'round-rectangle', 'background-color': '#13233a', 'border-color': '#58a6ff', 'border-width': 2.5, color: '#eaf2ff', 'font-size': 14, 'font-weight': 700, height: 'label', 'text-max-width': 'data(tmw)', 'text-wrap': 'wrap', 'text-valign': 'center', 'text-halign': 'center', 'line-height': 1.18, padding: 11 } },
  { selector: 'node[kind="feature"]', style: { shape: 'round-rectangle', 'background-color': '#16241b', 'border-color': '#3fb950', 'border-width': 2, color: '#e9ffef', 'font-size': 12.5, 'font-weight': 600, height: 'label', 'text-max-width': 'data(tmw)', 'text-wrap': 'wrap', 'text-valign': 'center', 'text-halign': 'center', 'line-height': 1.15, padding: 9 } },
  { selector: 'node[kind="task"]', style: { shape: 'round-rectangle', 'background-color': '#16273f', 'border-color': '#3b69a8', 'border-width': 1.8, color: '#eaf2ff', 'font-size': 11, height: 'label', 'text-max-width': 'data(tmw)', 'text-wrap': 'wrap', 'text-valign': 'center', 'text-halign': 'center', 'line-height': 1.15, padding: 7 } },
  { selector: 'node[kind="request"]', style: { shape: 'round-rectangle', 'background-color': '#1b2129', 'border-color': '#30363d', 'border-width': 1.2, color: '#c9d1d9', 'font-size': 9.5, height: 'label', 'text-max-width': 'data(tmw)', 'text-wrap': 'wrap', 'text-valign': 'center', 'text-halign': 'center', 'line-height': 1.12, padding: 5 } },
  { selector: 'node[kind="task"][status="done"]', style: { 'border-color': '#3fb950' } },
  { selector: 'node[kind="task"][status="partial"]', style: { 'border-color': '#d29922' } },
  { selector: 'node[kind="task"][status="blocked"]', style: { 'border-color': '#f85149' } },
  { selector: 'node[kind="task"][status="abandoned"]', style: { 'border-color': '#6e7681', opacity: 0.82 } },
  { selector: 'edge[tree="1"]', style: { 'line-color': '#2c3a4d', 'target-arrow-shape': 'none', width: 1.4, 'curve-style': 'bezier', opacity: 0.85 } },
  // Flow: the faint "spokes" from the session core to every request — they make ONE connected web (no orphan
  // islands) and barely show, so the eye reads the request clusters, not a busy star.
  { selector: 'edge[core="1"]', style: { 'line-color': '#283142', 'target-arrow-shape': 'none', width: 0.8, opacity: 0.25, 'curve-style': 'straight' } },
  { selector: 'node[id="_sun"]', style: { shape: 'ellipse', width: 'data(diam)', height: 'data(diam)', 'background-color': '#1a2740', 'border-color': '#7d93c8', 'border-width': 2.5, color: '#dce7ff', 'font-weight': 600, 'font-size': 11, 'text-max-width': 'data(diam)', 'text-wrap': 'wrap', 'text-valign': 'center', 'text-halign': 'center' } },
  // the request whose tool-work is currently expanded in Flow — cyan ring
  { selector: 'node[expanded="1"]', style: { 'border-width': 3, 'border-color': '#58d3ff' } },
  { selector: 'edge.faded', style: { opacity: 0.07 } },
];

// Both layouts are force-directed (short edges). fcose is preferred; cose is the no-plugin fallback.
const LAYOUTS = {
  fcose: { name: 'fcose', quality: 'proof', animate: false, randomize: true, padding: 22, nodeRepulsion: 5200, idealEdgeLength: 52, edgeElasticity: 0.5, nestingFactor: 0.1, gravity: 0.35, gravityRange: 3.6, numIter: 2600, tile: true, packComponents: true, nodeSeparation: 70, tilingPaddingVertical: 8, tilingPaddingHorizontal: 8 },
  cose: { name: 'cose', animate: false, padding: 20, randomize: true, componentSpacing: 70, nodeRepulsion: 9000, nodeOverlap: 14, idealEdgeLength: 52, edgeElasticity: 120, gravity: 0.5, numIter: 1400, initialTemp: 220, coolingFactor: 0.95, minTemp: 1.0 },
  breadthfirst: { name: 'breadthfirst', directed: true, padding: 22, spacingFactor: 1.0, animate: false },
  concentric: { name: 'concentric', padding: 22, animate: false, minNodeSpacing: 30 },
};

// Mount a graph into `el`. Returns { destroy, fit, relayout, select(id|null) }.
// graph may carry: spine[] (ordered ask ids -> a vertical backbone), activeId ("you are here"),
// alwaysShow[] (ids pinned visible at the clean zoom level, e.g. blocker / needs-you).
export async function mountGraph(el, graph, { onSelect, layout = 'fcose' } = {}) {
  const cytoscape = await loadCytoscape();
  el.innerHTML = '';
  let layoutName = graph.layout || layout;
  if (layoutName === 'fcose' && !hasFcose) layoutName = 'cose';
  const layoutCfg = { ...(LAYOUTS[layoutName] || LAYOUTS.cose) };

  // Request-spine backbone: align the user's requests on one vertical lane, in order, so the story
  // reads top-to-bottom and each request's sub-flow clusters tightly beside it (short local edges).
  // fcose honours these only at 'proof' quality; the cose fallback just ignores them.
  const idSet = new Set((graph.nodes || []).map((n) => n.id));
  const spine = (graph.spine || []).filter((id) => idSet.has(id));
  const hasSpine = layoutName === 'fcose' && spine.length >= 2;
  // `compact` (Flow view): keep the spine for LOD + edge styling but DROP the rigid vertical alignment —
  // forcing every request onto one column produced a long, low-occupancy "tadpole". Without it, fcose
  // minimizes edge length and packs in 2D, filling the canvas.
  const doAlign = hasSpine && !graph.compact;
  if (doAlign) {
    layoutCfg.alignmentConstraint = { vertical: [spine] };
    layoutCfg.relativePlacementConstraint = spine.slice(0, -1).map((id, i) => ({ top: id, bottom: spine[i + 1], gap: 135 }));
  } else if (hasSpine) {
    // pack tighter and use the whole area when not constrained to a line
    layoutCfg.nodeRepulsion = 7000;
    layoutCfg.gravity = 0.2;
    layoutCfg.gravityRange = 4.2;
  }
  if (graph.compact) {
    // Flow: ONE connected web around the session core (no orphan islands -> no packComponents tiling), and
    // DETERMINISTIC so a re-render doesn't reshuffle the whole thing. Core "spokes" set the request-ring
    // radius; the short hier edges keep each request's clusters hugging it.
    layoutCfg.randomize = false;
    layoutCfg.packComponents = false;
    layoutCfg.gravity = 0.45;
    layoutCfg.gravityRange = 3.0;
    layoutCfg.nodeRepulsion = 6200;
    layoutCfg.idealEdgeLength = (edge) => (edge.data('core') ? 130 : edge.data('hier') ? 26 : 52);
    layoutCfg.edgeElasticity = (edge) => (edge.data('core') ? 0.1 : 0.5);
  }

  const elements = [
    ...(graph.nodes || []).map((n) => ({ data: { ...n, level: n.level ?? (n.role === 'ask' ? 1 : 2) } })),
    ...(graph.edges || []).map((e, i) => ({ data: { id: e.id || `e${i}_${e.from}_${e.to}`, source: e.from, target: e.to, label: e.label || '', rel: e.rel || '', hier: e.hier || '', flow: e.flow || '', core: e.core ? '1' : '' } })),
  ];
  const cy = cytoscape({
    container: el,
    elements,
    style: STYLE,
    layout: { name: 'preset' }, // run the real layout explicitly below so we can await it before fitting
    wheelSensitivity: 0.25,
    minZoom: 0.1,
    maxZoom: 3,
    boxSelectionEnabled: false,
  });

  // "you are here" + spine edges (both endpoints on the backbone).
  if (graph.activeId && cy.$id(graph.activeId).length) cy.$id(graph.activeId).addClass('active-now');
  cy.edges().forEach((e) => { if (e.source().data('level') === 1 && e.target().data('level') === 1) e.addClass('spine'); });

  // The set kept visible at the clean (zoomed-out) level: the spine itself, the active request's
  // immediate sub-flow ("expand active"), and anything explicitly pinned (blocker / needs-you).
  const alwaysVisible = cy.collection();
  cy.nodes("[level = 1]").forEach((n) => alwaysVisible.merge(n));
  if (graph.activeId) alwaysVisible.merge(cy.$id(graph.activeId).closedNeighborhood().nodes());
  for (const id of graph.alwaysShow || []) if (cy.$id(id).length) alwaysVisible.merge(cy.$id(id));
  cy.nodes().filter((n) => n.data('blink') != null).forEach((n) => alwaysVisible.merge(n)); // recent actions stay visible to blink

  const fade = (node) => {
    if (!node) return cy.elements().removeClass('faded');
    const keep = node.closedNeighborhood();
    cy.elements().addClass('faded');
    keep.removeClass('faded');
  };
  cy.on('tap', 'node', (evt) => {
    fade(evt.target);
    onSelect?.(evt.target.data());
  });
  cy.on('tap', (evt) => {
    if (evt.target === cy) {
      fade(null);
      onSelect?.(null);
    }
  });

  // Semantic zoom (Google-Earth style): clean spine when zoomed out, full detail as you zoom in.
  // Detail appears once you've zoomed past 1.5x the spine-fit zoom; spine + pinned stay visible always.
  let baseZoom = cy.zoom();
  const applyLOD = () => {
    if (!hasSpine || graph.compact) return; // Flow (compact) collapses to requests instead of hiding by zoom
    const detailed = cy.zoom() > baseZoom * 1.5;
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        n.style('display', detailed || alwaysVisible.contains(n) ? 'element' : 'none');
      });
    });
  };
  cy.on('zoom', applyLOD);

  // Clean top-level view = fit the spine (+pinned), not the whole sprawl.
  const fit = () => {
    try {
      const focus = hasSpine ? alwaysVisible : cy.elements();
      cy.fit(focus.length ? focus : cy.elements(), 30);
      // frame content in the LOWER part of the canvas so the floating top info box doesn't cover it: shrink
      // a touch (margin all around) then pan down so the slack lands at the top (no bottom clip).
      const H = cy.height() || 1, W = cy.width() || 1;
      const frac = H > W ? 0.16 : 0.06;
      cy.zoom({ level: cy.zoom() * (1 - frac), renderedPosition: { x: W / 2, y: H / 2 } });
      cy.panBy({ x: 0, y: frac * H * 0.5 });
      baseZoom = cy.zoom();
      applyLOD();
    } catch {}
  };

  await new Promise((res) => {
    const l = cy.layout(layoutCfg);
    l.one('layoutstop', res);
    l.run();
  });
  fit();

  // Flow animation: recent actions blink (fast, newest fastest); parent (request) hubs glow (slow).
  const blinkNodes = cy.nodes().filter((n) => n.data('blink') != null);
  const hubNodes = cy.nodes().filter((n) => n.data('glow')); // only the active branch, not every hub
  let anim = null;
  if (blinkNodes.length || hubNodes.length) {
    anim = setInterval(() => {
      const t = (Date.now() % 100000) / 1000;
      cy.batch(() => {
        blinkNodes.forEach((n) => {
          const freq = 2.3 - (Number(n.data('blink')) || 0) * 0.45;
          const k = 0.5 + 0.5 * Math.sin(2 * Math.PI * freq * t);
          n.style({ 'border-color': '#cfe7ff', 'border-width': 1 + 4 * k, 'border-opacity': 0.35 + 0.65 * k });
        });
        const sk = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.4 * t);
        hubNodes.forEach((n) => n.style({ 'border-width': 2 + 3 * sk, 'border-opacity': 0.45 + 0.55 * sk }));
      });
    }, 80);
  }

  return {
    destroy: () => {
      try {
        if (anim) clearInterval(anim);
      } catch {}
      try {
        cy.destroy();
      } catch {}
    },
    fit,
    resize: () => {
      try {
        cy.resize();
        fit();
      } catch {}
    },
    relayout: () => {
      const l = cy.layout(layoutCfg);
      l.one('layoutstop', fit);
      l.run();
    },
    select: (id) => {
      const n = id ? cy.$id(id) : null;
      if (n && n.length) {
        n.select();
        fade(n);
        onSelect?.(n.data());
      } else {
        fade(null);
        onSelect?.(null);
      }
    },
  };
}
