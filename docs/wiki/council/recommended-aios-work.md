# Recommended Supercalm Work

_Council debate — 2026-06-24_

## Design Note: Recommended Supercalm Work After Studying gitnexus, graphify, and codebase-memory-mcp

### Recommended direction

Build **#1: Native Lightweight `project_graph` Index** first, but make v1 a **high-confidence structural graph**, not a broad regex-based code intelligence layer.

Defer **#2: Code Layer in Graph Panel** until the index is useful to agents through Supervisor/Preflight and `changed_impact`. The graph UI should become a thin visualization layer later, not the first consumer.

### What works

- A native `project_graph` fits Supercalm well:
  - uses Node built-ins / `node:sqlite`
  - avoids a new npm/tooling stack
  - creates persistent code memory beyond session memory
  - can support stale checks, impact analysis, route/tool maps, and deploy safety
- The idea is strongest when connected to agent workflows:
  - “what changed?”
  - “what does this affect?”
  - “which routes/tools/manifests are stale?”
  - “what should Supervisor or Preflight verify before deploy?”
- Starting small is the right instinct.

### What to change

Do **not** start with broad handwritten scanners as the foundation.

The best-supported critique is that regex/heuristic parsing can become “wrong in invisible ways,” and agents may overtrust it. Labeling it “good enough” is not sufficient unless confidence is built into the data model and downstream prompts/tools are forced to respect it.

Instead, v1 should prioritize facts Supercalm can extract reliably:

- manifests
- MCP tool registry
- explicit route definitions
- known service/config declarations
- git changed files
- deploy/session metadata
- direct imports only where extraction is mechanically reliable
- stale timestamps / file hashes / schema versions

Treat fuzzy discoveries as optional annotations, not authoritative edges.

### Recommended v1 scope

Build a small SQLite-backed `project_graph` with:

- `files`
- `symbols/surfaces` only where explicit
- `routes`
- `mcp_tools`
- `manifests/configs`
- `imports` with confidence
- `changed_files`
- `edges` with `source`, `confidence`, and `extracted_at`
- cache invalidation via file hash / mtime / schema version

Every edge should carry confidence, e.g.:

- `fact`: manifest entry, registered tool, explicit route config
- `declared`: static import/export extracted safely
- `heuristic`: grep/regex/dynamic inference
- `unknown/stale`: needs refresh or cannot verify

Agents and Supervisor should be instructed to treat `heuristic` edges as hints, not truth.

### Defer

Defer the **Code Layer in Graph Panel** until:

- `project_graph` has stable factual data
- `changed_impact` is useful in real sessions
- Supervisor/Preflight can consume it
- filtering/clustering rules are clear enough to avoid UI clutter

The graph panel is valuable, but adding code nodes early risks producing a crowded and misleading visualization. Recent UI friction around the graph/info panel reinforces that the graph needs better filtering before more node types are added.

### Main tradeoff

The key tradeoff is not “lightweight now vs semantic later.” It is:

- **trusted structural memory now**
  - lower ambition
  - deploy-safe
  - useful for automation
  - less misleading
- vs.
- **broad heuristic code graph now**
  - more impressive coverage
  - higher risk of stale/wrong edges
  - harder cache invalidation
  - easier for agents to overtrust

The stronger path is the first one.

### Decision

Proceed with the native `project_graph`, but define v1 as a **confidence-aware, high-fidelity structural index**. Use it first for `changed_impact`, stale checks, and Supervisor/Preflight guidance. Add UI graph overlays only after those workflows prove useful.
