// 3D force-directed graph renderer (three.js via vendored 3d-force-graph) — the "galaxy" view: glowing
// additive sprite nodes sized by a metric, colored by category, hub labels, drag-rotate / scroll-zoom.
// Mirrors the mountGraph(...) contract in graph.js so the map panel can swap renderers. The three libs
// share ONE three instance: 3d-force-graph + three-spritetext both read window.THREE, so three.min.js
// MUST load first (it sets the global; both then reuse it — no instance mixing for our custom sprites).

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
async function loadLibs() {
  if (libReady) return libReady;
  libReady = (async () => {
    if (!window.THREE) await injectScript('three.min.js'); // first: sets window.THREE for the others
    if (!window.SpriteText) await injectScript('three-spritetext.min.js');
    if (!window.ForceGraph3D) await injectScript('3d-force-graph.min.js');
    if (!window.ForceGraph3D) throw new Error('3d-force-graph failed to load');
    return window.ForceGraph3D;
  })();
  return libReady;
}

const CAT_COLOR = {
  ask: '#7aa7ff', explore: '#4d9be0', research: '#3fd0c4', edit: '#46d16a', exec: '#e0b13a',
  subagent: '#b07cff', decision: '#ff9d4d', plan: '#7c8bff', reason: '#7d8590', respond: '#9aa7b4', other: '#8b949e', file: '#6b7682',
};
function hexA(hex, a) {
  const h = String(hex || '#888').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function lighten(hex, amt) {
  const h = String(hex || '#888').replace('#', '');
  let r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  r = Math.round(r + (255 - r) * amt); g = Math.round(g + (255 - g) * amt); b = Math.round(b + (255 - b) * amt);
  return `rgb(${r},${g},${b})`;
}
function darken(hex, amt) {
  const h = String(hex || '#888').replace('#', '');
  let r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  r = Math.round(r * (1 - amt)); g = Math.round(g * (1 - amt)); b = Math.round(b * (1 - amt));
  return `rgb(${r},${g},${b})`;
}
const _texCache = new Map();
function glowTexture(THREE, color) {
  if (_texCache.has(color)) return _texCache.get(color);
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, hexA(color, 0.7)); // colored, not white-hot -> dimmer halo
  g.addColorStop(0.2, hexA(color, 0.5));
  g.addColorStop(0.5, hexA(color, 0.24));
  g.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  _texCache.set(color, tex);
  return tex;
}

// a 3D-globe disc: a small off-center highlight (light from upper-left) fading to a darker shaded edge,
// clipped to a circle — reads as a lit ball, not a flat or glowing dot.
const _discCache = new Map();
function discTexture(THREE, color) {
  if (_discCache.has(color)) return _discCache.get(color);
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const cx = s / 2, cy = s / 2, r = s / 2;
  const g = ctx.createRadialGradient(s * 0.37, s * 0.34, r * 0.05, cx, cy, r); // highlight offset up-left
  g.addColorStop(0, lighten(color, 0.5));
  g.addColorStop(0.32, color);
  g.addColorStop(0.72, darken(color, 0.24));
  g.addColorStop(0.93, darken(color, 0.52));
  g.addColorStop(0.99, darken(color, 0.62));
  g.addColorStop(1, hexA('#000000', 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.99, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  _discCache.set(color, tex);
  return tex;
}

// repel the MANAGER hubs (requests) from each other (in 3D) by a distance scaled to each group's size, so
// groups stay DISTINCT and navigable instead of collapsing into one giant cluster ("dynamic distancing").
function hubRepel3d(rOf, strength = 0.5, gap = 24) {
  let hubs = [];
  function force() {
    for (let i = 0; i < hubs.length; i++) {
      const a = hubs[i];
      for (let j = i + 1; j < hubs.length; j++) {
        const b = hubs[j];
        let dx = (b.x || 0) - (a.x || 0);
        let dy = (b.y || 0) - (a.y || 0);
        let dz = (b.z || 0) - (a.z || 0);
        const d2 = dx * dx + dy * dy + dz * dz;
        const md = rOf(a) + rOf(b) + gap;
        if (d2 < md * md && d2 > 0) {
          const dist = Math.sqrt(d2);
          const push = ((md - dist) / dist) * strength * 0.5;
          dx *= push; dy *= push; dz *= push;
          a.vx -= dx; a.vy -= dy; a.vz = (a.vz || 0) - dz;
          b.vx += dx; b.vy += dy; b.vz = (b.vz || 0) + dz;
        }
      }
    }
  }
  force.initialize = (n) => { hubs = n.filter((x) => x.kind === 'system'); };
  return force;
}

// graph: { nodes:[{id,label,short,size,color?,category,kind,hub,problem}], edges:[{from,to,faint?}] }
export async function mountGraph3d(el, graph, { onSelect, dims = 3 } = {}) {
  const FG = await loadLibs();
  const THREE = window.THREE;
  el.innerHTML = '';
  el.style.opacity = '0'; // hide while the force layout settles — we fade in the SETTLED galaxy so the load is
  el.style.transition = 'opacity 0.5s ease'; // never the bouncy simulation flying into place
  const buildNode = (n) => {
    const o = {
      id: n.id,
      name: (n.label || n.id).replace(/\n/g, '  '),
      short: (n.short || n.label || n.id).split('\n')[0],
      size: Math.max(2, n.size || 4),
      color: n.color || CAT_COLOR[n.category] || CAT_COLOR.other,
      kind: n.kind,
      hub: !!n.hub,
      problem: n.problem,
      blink: n.blink,
      glow: !!n.glow,
    };
    if (n.pin) { o.fx = 0; o.fy = 0; o.fz = 0; o.pinned = true; } // pin the session core at the center
    return o;
  };
  const nodes = (graph.nodes || []).map(buildNode);
  const links = (graph.edges || []).map((e) => ({ source: e.from, target: e.to, faint: e.faint ? 1 : 0, core: e.core ? 1 : 0, cross: e.cross ? 1 : 0 }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const nodeRecs = []; // per-node sprite refs -> the rAF drives position (zoom-spread), opacity (spotlight dim), blink, glow
  // parent→children (from string-id links, before force-graph mutates them) for click-to-zoom-into-subtree
  const kids = new Map();
  const parent = new Map();
  for (const l of links) {
    if (!kids.has(l.source)) kids.set(l.source, []);
    kids.get(l.source).push(l.target);
    parent.set(l.target, l.source);
  }
  // Static hierarchy dim: a small child that surrounds a MUCH bigger parent is dimmed so the big hub pops and
  // the swarm recedes. Requests (kind 'system') stay full bright; the dimming scales with how much smaller the
  // child is than its parent. Read by the rAF loop as n.lvlDim (default 1).
  for (const n of nodes) {
    const pn = nodeById.get(parent.get(n.id));
    n.lvlDim = n.kind !== 'system' && pn && pn.size > n.size * 2 ? Math.max(0.4, Math.min(0.9, 0.4 + 0.55 * (n.size / pn.size))) : 1;
  }
  const descN = (id) => { let c = 0; const st = [...(kids.get(id) || [])]; while (st.length) { c++; const x = st.pop(); for (const k of kids.get(x) || []) st.push(k); } return c; };
  const groupR = new Map(nodes.filter((n) => n.kind === 'system').map((n) => [n.id, (n.size || 40) * 0.5 + 30 + 8 * Math.sqrt(descN(n.id))]));
  function subtree(id) {
    const root = (kids.get(id) || []).length ? id : parent.get(id) || id; // leaf -> its cluster
    const set = new Set([root]);
    const st = [root];
    while (st.length) {
      const x = st.pop();
      for (const c of kids.get(x) || []) if (!set.has(c)) { set.add(c); st.push(c); }
    }
    return set;
  }

  // orbit (turntable) controls so the galaxy can slowly auto-rotate; controlType is a CONSTRUCTOR option, not a
  // chainable setter. dims===2 (legacy flat view) keeps trackball.
  const Graph = FG({ controlType: dims === 2 ? 'trackball' : 'orbit' })(el)
    .backgroundColor('#04060d')
    .numDimensions(dims)
    .graphData({ nodes, links })
    .nodeRelSize(4)
    .nodeLabel((n) => `<div style="font:11px ui-monospace,Menlo,monospace;color:#cdd9e5;max-width:240px">${escapeHtmlSafe(n.name)}</div>`)
    .nodeThreeObject((n) => {
      const group = new THREE.Group();
      const d = n.size * (n.problem ? 1.1 : 1);
      const rec = { node: n, glow: null, disc: null, ring: null, label: null, pulse: null, pulseBase: 0, pulseRank: n.blink, hub: null, hubBase: 0 };
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(THREE, n.color), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.28 }));
      const gs = Math.max(d * 2.2, 9); // min halo so even the tiniest nodes emit a noticeable light
      glow.scale.set(gs, gs, 1);
      group.add(glow);
      rec.glow = glow;
      const disc = new THREE.Sprite(new THREE.SpriteMaterial({ map: discTexture(THREE, n.color), depthWrite: false, transparent: true, opacity: 0.96 }));
      disc.scale.set(d, d, 1);
      group.add(disc);
      rec.disc = disc;
      if (n.blink != null) { // the 5 most-recent actions pulse; rank 0 = newest = fastest
        const pulse = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(THREE, n.color), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.3 }));
        pulse.scale.set(d * 1.7, d * 1.7, 1);
        group.add(pulse);
        rec.pulse = pulse;
        rec.pulseBase = d * 1.7;
      }
      if (n.problem) {
        const ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(THREE, '#ff5247'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.4 }));
        ring.scale.set(d * 2.1, d * 2.1, 1);
        group.add(ring);
        rec.ring = ring;
      }
      if (n.glow) { // ONLY the active branch glows (parents of the current work), not every hub
        const hg = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(THREE, n.color), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.3 }));
        hg.scale.set(d * 2.5, d * 2.5, 1);
        group.add(hg);
        rec.hub = hg;
        rec.hubBase = d * 2.5;
      }
      if (n.hub) {
        const label = new window.SpriteText(n.short);
        label.color = '#eef3f9';
        label.textHeight = n.kind === 'system' ? Math.min(5.5, 2.5 + n.size * 0.08) : 1.9; // smaller, to match the smaller nodes
        label.fontWeight = n.kind === 'system' ? '600' : '400';
        label.backgroundColor = 'rgba(4,6,13,0.62)'; // dark pill so text stays readable over bright nodes
        label.padding = 1.3;
        label.borderRadius = 2;
        label.material.depthWrite = false;
        label.material.transparent = true;
        label.position.set(0, d * 0.6 + label.textHeight * 0.7 + 1.5, 0);
        group.add(label);
        rec.label = label;
      }
      nodeRecs.push(rec);
      return group;
    })
    .linkColor((l) => (l.core || l.faint ? 'rgba(120,140,170,0.04)' : l.cross ? 'rgba(150,172,205,0.13)' : 'rgba(130,150,180,0.14)'))
    .linkWidth(0.35)
    .linkOpacity(0.5)
    .onNodeClick((n) => { // remember where we are, then aim at it -> zooming spreads AROUND it
      try { const cam = Graph.camera(), tg = Graph.controls().target; viewStack.push({ pos: { x: cam.position.x, y: cam.position.y, z: cam.position.z }, tgt: { x: tg.x, y: tg.y, z: tg.z } }); } catch {}
      focus(n);
      onSelect?.(n);
    })
    .onBackgroundClick(() => { // step back ONE level; at the bottom, the exact overview
      const prev = viewStack.pop();
      if (prev) { try { Graph.cameraPosition(prev.pos, prev.tgt, 550); } catch {} }
      else overview();
      onSelect?.(null);
    })
    .showNavInfo(true);

  // More room INSIDE each cluster (longer hier links + stronger LOCAL repulsion) so sub-nodes don't pile on
  // their hub. distanceMax caps repulsion to a local range so clusters still pack together (less empty
  // border), and stronger core links pull clusters toward the center.
  try {
    Graph.d3Force('charge').strength(-42).distanceMax(90);
    // hier links: pull the child to just OUTSIDE the hub's sprite (size-aware), not a fixed 24 that buries
    // children inside big hubs. The deterministic spreadChildren() pass below then guarantees the clearance.
    Graph.d3Force('link').distance((l) => (l.core ? 60 : l.faint ? 50 : l.cross ? 34 : ((l.source.size || 6) + (l.target.size || 6)) * 0.5 + 9)).strength((l) => (l.core ? 0.2 : l.faint ? 0.04 : l.cross ? 0.4 : 1));
    Graph.d3Force('center').strength(1);
    Graph.d3Force('hubrepel', hubRepel3d((n) => groupR.get(n.id) || 40, 0.4, 28)); // lighter: cross-links now weave related requests
  } catch {}

  // After the force layout settles, push each child radially OUT onto a shell clear of its hub's sprite (moving
  // the child's whole subtree with it), so big hubs aren't smothered by their children and stay clickable.
  // Deterministic, BFS top-down (sun → request → cluster → turn) so parents are finalized before their kids.
  const translateSubtree = (rootId, dx, dy, dz) => {
    const st = [rootId];
    while (st.length) { const n = nodeById.get(st.pop()); if (!n) continue; n.x = (n.x || 0) + dx; n.y = (n.y || 0) + dy; n.z = (n.z || 0) + dz; for (const c of kids.get(n.id) || []) st.push(c); }
  };
  function spreadChildren() {
    const GAP = 7;
    const order = []; const seen = new Set(); const q = ['_sun'];
    while (q.length) { const id = q.shift(); if (seen.has(id)) continue; seen.add(id); order.push(id); for (const c of kids.get(id) || []) q.push(c); }
    for (const id of order) {
      const p = nodeById.get(id); if (!p) continue;
      const pr = (p.size || 6) * 0.5;
      for (const cid of kids.get(id) || []) {
        const c = nodeById.get(cid); if (!c) continue;
        const minD = pr + (c.size || 6) * 0.5 + GAP;
        let dx = (c.x || 0) - (p.x || 0), dy = (c.y || 0) - (p.y || 0), dz = (c.z || 0) - (p.z || 0);
        let d = Math.hypot(dx, dy, dz);
        if (d < 1e-3) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dz = dims === 2 ? 0 : Math.random() - 0.5; d = Math.hypot(dx, dy, dz) || 1; }
        if (d < minD) { const s = minD - d; translateSubtree(cid, (dx / d) * s, (dy / d) * s, (dz / d) * s); }
      }
    }
    for (const n of nodes) { n.fx = n.x; n.fy = n.y; n.fz = n.z; }
  }

  Graph.warmupTicks(90); // settle most of the layout INVISIBLY (pre-render compute) so the visible load isn't bouncy
  Graph.cooldownTicks(90); // a rendered tail (still hidden) finishes settling, then onEngineStop fires + we reveal
  // Reveal only once the galaxy is settled + framed — a clean fade-in, never the simulation flying into place.
  let revealed = false, revealTimer = 0;
  const reveal = () => { if (revealed) return; revealed = true; clearTimeout(revealTimer); try { el.style.opacity = '1'; } catch {} };
  revealTimer = setTimeout(reveal, 5000); // safety: never stay hidden if onEngineStop is delayed
  let fitted = false;
  Graph.onEngineStop(() => {
    if (fitted) return;
    fitted = true;
    spreadChildren(); // clear the hubs of their children before we frame + capture the overview
    if (dims === 2) faceOn(); // flat "Obsidian galaxy": look straight at the x-y plane FIRST, then frame
    size(); // re-read the (now-final) container size so we fit the REAL frame in one step
    try { Graph.zoomToFit(0, 4); } catch {} // INSTANT fit — no animated shrink-then-expand on load
    requestAnimationFrame(() => { captureBase(); reveal(); }); // capture + fade in the settled galaxy
  });
  function faceOn() {
    try {
      const dist = Graph.camera().position.length() || 400;
      Graph.cameraPosition({ x: 0, y: 0, z: dist }, { x: 0, y: 0, z: 0 }, 0);
    } catch {}
  }
  // size to container, and render the galaxy lower in the frame so the top info overlay doesn't cover the
  // dense center. setViewOffset shifts the PROJECTION only (camera position/target untouched), so it doesn't
  // disturb the zoom-spread/dim math. A portrait side-panel has vertical margin to spare (galaxy is
  // width-constrained); a landscape/expanded frame has less, so shift less there to avoid clipping the bottom.
  const size = () => {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return; // hidden / zero-size container (e.g. a background browser tab) — never fit to that:
    // a fit into a 0-size viewport drives the camera onto the target, and on return the zoom-spread reads a
    // tiny camera distance and "expands deep inside a node". Skip; we re-frame when a real size comes back.
    Graph.width(w).height(h);
    try {
      const cam = Graph.camera();
      const shift = h > w ? 0.16 : 0.06; // fraction of height to push the content DOWN (negative y offset)
      cam.setViewOffset(w, h, 0, -Math.round(h * shift), w, h);
      cam.updateProjectionMatrix();
    } catch {}
  };
  size();
  // Slow auto-rotation (turntable). OrbitControls rotates the camera around the look-at target at constant
  // distance, so the zoom-driven spacing (which reads camera DISTANCE, not angle) is unaffected; user drag and
  // click-to-focus still work and just rotate from wherever you leave it. dims===2 keeps the flat face-on view.
  if (dims !== 2) {
    try {
      const c = Graph.controls();
      c.autoRotate = true;
      c.autoRotateSpeed = 0.35; // ~3 min per revolution — gentle
    } catch {}
  }

  // One rAF drives everything per node: zoom-spread position, the spotlight DIM (fade nodes far from the
  // look-at point when zoomed in so the active cluster stands out), recent-action blink (fast), hub glow
  // (slow). Runs unconditionally — nodeRecs fills in asynchronously as nodeThreeObject is called.
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let raf = 0;
  const loop = () => {
    const t = (Date.now() % 100000) / 1000;
    const sk = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.4 * t); // slow hub glow
    let tgt = null;
    let factor = 1;
    let spotR = 0;
    let fadeR = 1;
    let dimOn = false;
    if (baseReady) {
      try {
        tgt = Graph.controls().target;
        const camDist = Graph.camera().position.distanceTo(tgt) || baseDist;
        factor = clamp(baseDist / camDist, 0.6, 3.2); // zoom in -> spread, out -> compress
        spotR = camDist * 1.0;
        fadeR = camDist * 1.3;
        dimOn = factor > 1.25; // only spotlight once you've zoomed in
      } catch {
        tgt = null;
      }
    }
    if (forceBase) { factor = 1; dimOn = false; } // hold the base layout while re-fitting the overview
    for (const r of nodeRecs) {
      const n = r.node;
      let spot = 1; // spotlight factor: when zoomed IN, fade nodes far from the look-at point
      if (tgt && !n.pinned) {
        const b = basePos.get(n.id);
        if (b) {
          n.fx = tgt.x + (b.x - tgt.x) * factor;
          n.fy = tgt.y + (b.y - tgt.y) * factor;
          n.fz = tgt.z + (b.z - tgt.z) * factor;
          if (dimOn) {
            const dx = n.fx - tgt.x, dy = n.fy - tgt.y, dz = n.fz - tgt.z;
            spot = clamp(1 - (Math.sqrt(dx * dx + dy * dy + dz * dz) - spotR) / fadeR, 0.08, 1);
          }
        }
      }
      const ld = n.lvlDim || 1; // static hierarchy dim — a small child of a much-bigger parent recedes
      if (r.glow) r.glow.material.opacity = 0.28 * ld * spot; // every node emits a noticeable light; children dimmer
      if (r.disc) r.disc.material.opacity = 0.96 * (0.6 + 0.4 * ld) * spot; // body dims only mildly, so children stay visible
      if (r.ring) r.ring.material.opacity = 0.45 * spot;
      // Labels: declutter the OVERVIEW (only the session core + the active branch are named) so the galaxy never
      // becomes a wall of text; zooming in reveals the nearby labels by the spotlight.
      if (r.label) r.label.material.opacity = dimOn ? clamp(spot, 0.1, 1) : n.id === '_sun' || n.glow ? 0.9 : 0;
      if (r.pulse) {
        const k = 0.5 + 0.5 * Math.sin(2 * Math.PI * (2.4 - r.pulseRank * 0.45) * t);
        r.pulse.material.opacity = (0.28 + 0.85 * k) * spot; // brighter recent-action pulse
        const sc = r.pulseBase * (1 + 0.45 * k);
        r.pulse.scale.set(sc, sc, 1);
      }
      if (r.hub) {
        r.hub.material.opacity = (0.42 + 0.72 * sk) * spot; // brighter active-branch glow (already-lit nodes pop more)
        const sc = r.hubBase * (0.9 + 0.55 * sk);
        r.hub.scale.set(sc, sc, 1);
      }
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  function focus(n) {
    const nx = n.x || 0, ny = n.y || 0, nz = n.z || 0;
    const r = Math.hypot(nx, ny, nz);
    // Dive to a fixed FRACTION of the overview distance so the rAF's factor (= baseDist / camDist) reliably
    // crosses the spread+dim threshold (1.25) no matter the galaxy/node size — clicking always zooms INTO the
    // cluster and dims the rest. A fixed ABSOLUTE distance stopped triggering once the overview fit tightly
    // (baseDist small ⇒ factor never exceeded 1.25), which read as "click-to-expand/dim stopped working".
    const camDist = Math.max(70, (baseDist || 320) * 0.4); // factor ≈ 1/0.4 = 2.5 ⇒ always dims the background
    let ux = 0, uy = 0, uz = 1; // sun/near-origin node: approach along +z
    if (r > 1e-3) { ux = nx / r; uy = ny / r; uz = nz / r; }
    Graph.cameraPosition({ x: nx + ux * camDist, y: ny + uy * camDist, z: nz + uz * camDist }, { x: nx, y: ny, z: nz }, 800);
  }

  // ---- ZOOM-DRIVEN SPACING (the user's method) -------------------------------------------------------
  // All nodes always stay visible (the full galaxy). After the initial layout settles we capture each node's
  // BASE position + the overview camera distance, drop the layout forces, freeze the sim's alpha decay so it
  // keeps ticking (so EDGES follow), and pin every node. The rAF loop then sets each node's position to
  //   pos = lookAtTarget + (basePos - lookAtTarget) * factor,  factor = baseDist / currentCamDistance
  // so zooming IN spreads nodes apart AROUND whatever you're looking at, and zooming OUT pulls them back to
  // the exact base layout (factor 1). Clicking a node just aims the camera at it, so you zoom into THAT cluster.
  const basePos = new Map();
  let baseReady = false, baseDist = 320, baseCam = null, baseTarget = null, forceBase = false;
  const viewStack = []; // camera states: pushed on node-click, popped on background-click (back ONE level)
  function snapCam() {
    try {
      const cam = Graph.camera(), tg = Graph.controls().target;
      baseDist = cam.position.distanceTo(tg) || baseDist;
      baseCam = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
      baseTarget = { x: tg.x, y: tg.y, z: tg.z };
    } catch {}
  }
  function captureBase() {
    if (baseReady) return;
    for (const n of nodes) basePos.set(n.id, { x: n.x || 0, y: n.y || 0, z: n.z || 0 });
    snapCam(); // baseDist/baseCam = the actual fitted overview (this runs AFTER zoomToFit settles)
    try {
      Graph.d3Force('charge', null);
      Graph.d3Force('link', null);
      Graph.d3Force('center', null);
      Graph.d3Force('hubrepel', null);
      Graph.d3AlphaDecay(0); // keep ticking forever so links track the zoom-driven node moves
      Graph.d3ReheatSimulation();
    } catch {}
    for (const n of nodes) { n.fx = n.x; n.fy = n.y; n.fz = n.z; } // hand position control to the rAF
    baseReady = true;
  }
  // EXACT, repeatable overview: animate the camera back to the captured base view (no zoomToFit feedback,
  // so it's the same size every time). Clears the back-stack.
  function overview() {
    viewStack.length = 0;
    if (baseCam) { try { Graph.cameraPosition(baseCam, baseTarget, 600); } catch {} }
    else Graph.zoomToFit(600, 4);
  }
  // Re-frame to FILL the current container in ONE INSTANT step (container resize / fullscreen / late layout) —
  // hold nodes at base, fit with no animation, then re-snap the overview reference. No shrink-then-expand.
  function frame() {
    size();
    if (!baseReady) { try { Graph.zoomToFit(0, 4); } catch {} return; }
    forceBase = true;
    try { Graph.controls().target.set(baseTarget?.x || 0, baseTarget?.y || 0, baseTarget?.z || 0); } catch {}
    try { Graph.zoomToFit(0, 4); } catch {}
    requestAnimationFrame(() => { snapCam(); forceBase = false; viewStack.length = 0; });
  }
  // Snap to fill the frame whenever the container's size changes (the panel finishing its flex layout after
  // reveal, a fullscreen toggle, a window resize) — instantly, so it never fits small then expands.
  let ro = null;
  try { ro = new ResizeObserver(() => { if (baseReady) frame(); }); ro.observe(el); } catch {}
  // Tab-switch guard: a backgrounded tab can leave the camera glitched DEEP inside the galaxy (the rAF/controls
  // pause then resume on a stale/0-size frame). On return, if the camera came back abnormally close (closer than
  // a normal click-to-focus), snap back to the clean overview. A deliberate zoom is left alone.
  const onVis = () => { if (document.visibilityState === 'visible' && baseReady) { try { if (Graph.camera().position.distanceTo(Graph.controls().target) < (baseDist || 320) * 0.3) overview(); } catch {} } };
  document.addEventListener('visibilitychange', onVis);

  return {
    destroy() {
      try { if (raf) cancelAnimationFrame(raf); } catch {}
      try { clearTimeout(revealTimer); el.style.opacity = ''; el.style.transition = ''; } catch {}
      try { ro && ro.disconnect(); } catch {}
      try { document.removeEventListener('visibilitychange', onVis); } catch {}
      try {
        Graph._destructor && Graph._destructor();
      } catch {}
      el.innerHTML = '';
    },
    fit() { overview(); }, // exact, repeatable overview (no feedback)
    resetView() { overview(); },
    resize() { try { frame(); } catch {} }, // re-frame (size + re-fit) to fill the new canvas size
    relayout() {
      try {
        Graph.numDimensions(3);
        Graph.d3ReheatSimulation();
      } catch {}
    },
    select(id) {
      const n = nodes.find((x) => x.id === id);
      if (n) focus(n);
    },
    _counts: () => ({ n: nodes.length, recs: nodeRecs.length }), // headless verification hook (?mapdebug)
    _autoRotate: () => { try { return !!Graph.controls().autoRotate; } catch { return null; } },
    _camPos: () => { try { const p = Graph.camera().position; return { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) }; } catch { return null; } },
    // headless occlusion metric: avg fraction of each hub's (request/cluster) screen disc covered by a NEARER
    // child. The goal is < 0.30 — i.e. the major hubs stay visible/clickable through their children.
    _occlusion: () => {
      const THREE = window.THREE;
      const cam = Graph.camera();
      const W = el.clientWidth || 1, H = el.clientHeight || 1;
      const fov = (cam.fov || 50) * Math.PI / 180;
      const V = new THREE.Vector3();
      const proj = (n) => { V.set(n.x || 0, n.y || 0, n.z || 0); const depth = cam.position.distanceTo(V); V.project(cam); return { x: (V.x * 0.5 + 0.5) * W, y: (-V.y * 0.5 + 0.5) * H, depth }; };
      const srad = (wr, dist) => (wr * (H / 2)) / (Math.tan(fov / 2) * Math.max(1, dist));
      // only hubs that actually HAVE children can be occluded; report systems and clusters separately
      const hubs = nodes.filter((n) => (n.kind === 'system' || n.kind === 'cluster') && (kids.get(n.id) || []).length >= 2);
      let sum = 0, cnt = 0, worst = 0, over30 = 0, sysSum = 0, sysCnt = 0, sysOver = 0;
      for (const h of hubs) {
        const hp = proj(h); const hr = srad((h.size || 6) * 0.5, hp.depth);
        if (hr < 2) continue;
        const kidNodes = (kids.get(h.id) || []).map((id) => nodeById.get(id)).filter(Boolean).map((c) => ({ p: proj(c), r0: c.size || 6 }));
        let covered = 0, samples = 0;
        for (let a = 0; a < 12; a++) for (const rr of [0.2, 0.55, 0.9]) {
          const px = hp.x + Math.cos((a / 12) * 2 * Math.PI) * hr * rr;
          const py = hp.y + Math.sin((a / 12) * 2 * Math.PI) * hr * rr;
          samples++;
          for (const c of kidNodes) { const cr = srad(c.r0 * 0.5, c.p.depth); if (c.p.depth < hp.depth - 1 && Math.hypot(c.p.x - px, c.p.y - py) < cr) { covered++; break; } }
        }
        const f = covered / Math.max(1, samples); sum += f; cnt++; if (f > worst) worst = f; if (f > 0.3) over30++;
        if (h.kind === 'system') { sysSum += f; sysCnt++; if (f > 0.3) sysOver++; }
      }
      return { avg: +(sum / Math.max(1, cnt)).toFixed(3), worst: +worst.toFixed(3), over30, hubs: cnt, sysAvg: +(sysSum / Math.max(1, sysCnt)).toFixed(3), sysOver, sysCnt };
    },
    // Incremental growth: add only the NEW nodes (seeded at their parent's captured position + a little jitter,
    // then pinned) so existing stars never move and the camera never resets. Returns false to ask the caller
    // for a clean remount in the cases we don't grow in place (base layout not captured yet, or a node was
    // removed/pruned). Pure label/size changes are left alone (cosmetic on the galaxy).
    update(next) {
      if (!baseReady) return false; // overview not captured yet -> remount cleanly
      const want = next.nodes || [];
      const wantIds = new Set(want.map((n) => n.id));
      for (const n of nodes) if (!wantIds.has(n.id)) return false; // a node vanished -> remount (rare)
      const fresh = want.filter((n) => !nodeById.has(n.id));
      if (!fresh.length) return true; // nothing structural added -> hold the galaxy steady
      const par = new Map();
      for (const e of next.edges || []) if (!par.has(e.to)) par.set(e.to, e.from);
      const jit = () => (Math.random() - 0.5) * 16;
      for (const n of fresh) {
        const o = buildNode(n);
        const pb = basePos.get(par.get(n.id)) || basePos.get('_sun') || { x: 0, y: 0, z: 0 };
        o.x = o.fx = pb.x + jit();
        o.y = o.fy = pb.y + jit();
        o.z = o.fz = pb.z + jit();
        basePos.set(o.id, { x: o.x, y: o.y, z: o.z });
        nodes.push(o);
        nodeById.set(o.id, o);
      }
      // rebuild links + the kids/parent maps from the new edge list (force-graph re-resolves by id; existing
      // node OBJECTS are reused so their positions and three.js sprites are untouched — only `fresh` get built).
      const nl = (next.edges || []).map((e) => ({ source: e.from, target: e.to, faint: e.faint ? 1 : 0, core: e.core ? 1 : 0, cross: e.cross ? 1 : 0 }));
      links.length = 0;
      for (const l of nl) links.push(l);
      kids.clear();
      parent.clear();
      for (const l of nl) { if (!kids.has(l.source)) kids.set(l.source, []); kids.get(l.source).push(l.target); parent.set(l.target, l.source); }
      try { Graph.graphData({ nodes, links }); } catch { return false; }
      return true;
    },
  };
}

function escapeHtmlSafe(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
