# Agent View Exceptional Gates

This is the execution contract for the AG-UI-first Agent View work. A task is not complete unless its evidence satisfies the gates below.

## Global Hard Rules

- No "done" claim without evidence from tests, screenshots, measurements, or direct browser checks.
- Every visual task needs desktop and mobile screenshots.
- Every design decision is checked against Manus first, with Claude Desktop as fallback.
- At least one proxy/third-party model must critique screenshots against the goal.
- If a gate fails, fix it, rollback it, or explicitly mark the task failed.
- CopilotKit is not added in phase one unless AG-UI-only fails its fallback gate.
- AG-UI view must lazy-load and must not bloat the default session page.
- Existing Terminal and current Conversation views must keep working.

## 1. AG-UI Dependency And Adapter

Exceptional condition: only `@ag-ui/core` and `@ag-ui/client` are added; package and bundle deltas are measured; adapter fixtures come from real timeline-shaped data; AG-UI event IDs are stable by repeat generation and diff; every emitted event validates against AG-UI schemas; all important Supercalm event categories are represented.

What I will do: install minimal AG-UI packages, build a server adapter from existing timeline blocks, preserve source references on every normalized item, validate every emitted event with AG-UI schemas, add repeatability tests, and report package/bundle impact.

## 2. Supercalm Normalized Event Schema

Exceptional condition: Supercalm internal event types are defined before UI rendering; every normalized item has required identity, time, display, source metadata, and raw source references; metadata is not dropped during adapter conversion; roundtrip/snapshot tests catch loss.

What I will do: create a normalized request-group schema around messages, decisions, activity, artifacts, change sets, terminal evidence, and source refs; test that source metadata survives conversion and expose the schema through the Agent API.

## 3. Second Agent View

Exceptional condition: Agent View is a third selectable view beside Terminal and Conversation; its renderer is dynamically imported; CSS is scoped; import/render failures show a recoverable fallback; browser checks prove the default session load does not fetch Agent View assets.

What I will do: add an icon tab and hidden Agent panel, load the renderer only when selected, keep Terminal and Conversation code paths intact, and verify network/module loading behavior in the browser.

## 4. Manus-Style Request Grouping

Exceptional condition: each user request becomes one primary block; edits, terminal evidence, decisions, files, and activity are grouped under that request; only active/latest request opens by default; older requests stay compact and expandable; screenshots are compared against Manus/Claude task-timeline patterns.

What I will do: render a request-first timeline from normalized groups, move evidence inside request blocks, use concise collapsed summaries, and visually compare layout density and hierarchy against reference screenshots/checklist before keeping it.

## 5. Artifact/Change Sections

Exceptional condition: changed files are parsed into file-level artifacts where possible; image/file attachments render as artifacts instead of raw rows; terminal evidence is trimmed by default with expansion for detail; ordering remains stable after refresh.

What I will do: parse status/stat/diff text into artifacts, show concise file/image cards, keep raw details behind expansion, and run refresh stability checks on ordering.

## 6. Persistent Side Map/Usage Panel

Exceptional condition: the side map/usage panel remains visible on desktop and stacks on mobile; selecting an Agent request updates the side snapshot context; no extra busy controls are added; continuity is proven by desktop and mobile screenshots.

What I will do: wire selected request state from Agent View into the existing side panel, keep the panel visible in desktop layouts, reuse existing side tabs, and verify the layout at desktop and phone widths.

## 7. Manus/Claude Reference Gate

Exceptional condition: research starts with Manus, uses Claude Desktop as fallback, and produces an explicit visual checklist before styling; screenshots are compared side-by-side; changes that do not move Supercalm closer are rejected or rolled back.

What I will do: use web/image search for references, translate observations into a checklist, capture Supercalm screenshots, and judge each iteration against that checklist rather than subjective preference.

## 8. Mobile QA

Exceptional condition: 390px and 430px widths are tested; top, middle, and bottom scroll states are captured; horizontal overflow is measured; composer is not clipped; tap targets and headers are readable.

What I will do: run browser viewport checks at 390 and 430 widths, capture scroll-position screenshots, use DOM measurements for overflow/clipping, and fix any layout issue before final reporting.

## 9. Refresh/Scroll Stability

Exceptional condition: expanded keys and selected request ID persist across refreshes; scrollTop is preserved while reading history; scripted browser refresh/update checks fail if the view snaps to latest or collapses open sections.

What I will do: store view state per session/view, restore scroll after render, avoid auto-scroll unless explicitly requested, and run browser scripts that expand old sections, trigger reload/update, and verify position remains stable.

## 10. Performance Budget

Exceptional condition: package install size, JS/CSS transfer size, and gzip deltas are measured; Agent renderer is absent from the default Terminal load; default session bundle growth is justified or reduced; work stops for review if the default page becomes too heavy.

What I will do: record package size, measure static file sizes before/after, inspect browser network requests for lazy loading, and keep AG-UI-specific code out of the default synchronous path.

## 11. Visual QA Loop

Exceptional condition: initial screenshots are captured; a proxy/third-party model critiques screenshots against the goal; accepted critique is applied or rejected with reason; improved screenshots are captured; desktop/mobile regressions are checked at the end.

What I will do: take screenshots before and after meaningful UI iterations, consult a proxy model with the screenshots and goal, apply useful critique, and retain evidence of the visual loop.

## 12. Fallback/Rollback

Exceptional condition: Terminal and current Conversation views still work; Agent View import/render/API errors have user-visible fallback states; composer state is preserved; per-view scroll is preserved; final notes include rollback path for this feature.

What I will do: keep the new view additive, add error boundaries around Agent View loading and rendering, avoid touching composer behavior unless necessary, test existing views, and document how to disable/remove the Agent View changes if needed.
