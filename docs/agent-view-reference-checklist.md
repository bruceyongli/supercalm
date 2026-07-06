# Agent View Reference Checklist

Research date: 2026-06-11

Primary references:

- Manus-style direction from public screenshots/search: task-first interface with a clean prompt surface, concise task-type controls, and a work-focused neutral layout.
- Claude Cowork reference: a dedicated agent tab, central conversation/task stream, progress/artifacts/context in a persistent right sidebar, and command/tool evidence embedded in the task flow.
- Claude Artifacts reference: significant reusable outputs are moved into a dedicated artifact surface instead of dumped as raw chat text.
- Lovable/editor-agent reference: chat remains visible beside code/preview, with generated project changes available for review and iteration.
- General AI chat UX guidance: collapse older context, expose detail levels, keep roles transparent, and use full-page chat on mobile.
- Terminal-agent HCI guidance: preserve transparency of actions and low-friction human inspection; do not hide terminal evidence entirely.

Sources:

- https://simonwillison.net/2026/Jan/12/claude-cowork/
- https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them
- https://www.linkedin.com/posts/vitalyfriedman_ux-design-activity-7354454045761126401-sgyj
- https://arxiv.org/abs/2603.10664
- https://uibakery.io/blog/what-is-lovable-ai

## Visual Targets

- Request-first hierarchy: one major block per user request. Evidence is inside the request, not standalone unless it predates the first request.
- Progressive detail: collapsed blocks show what changed, what ran, and what needs input; expanded sections reveal raw logs, patches, and source events.
- Persistent context: the existing side map/usage panel remains visible on desktop; Agent View selection should update the side snapshot rather than replacing it.
- Artifact surface: images, files, and changed files appear as scannable artifacts; raw event cards are secondary.
- Terminal transparency: terminal snippets are request-scoped and expandable; no global latest-80-lines block dominates the view.
- Low visual noise: no extra labels or busy controls; use icons and concise status tags; keep type scale compact and consistent with Supercalm.
- Stable reading: expanding a section, refreshing, or receiving live updates must not collapse the section or jump the user to the newest message.
- Mobile: use full-width request blocks, stack the side panel below, keep tap targets readable, and avoid clipped composer or horizontal overflow.

## Reject Criteria

- A design that hides the side map/usage panel on desktop.
- A design where edits or terminal lines are disconnected from the request that caused them.
- A design that requires users to open raw event details to understand the task outcome.
- A design that collapses expanded sections on live refresh.
- A design that downloads Agent View code before the user selects the Agent tab.
- A design that makes mobile controls or message content feel denser than the existing composer can support.
