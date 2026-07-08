# Security checkpoint & implementation context — phone v2 (v0.3.19..v0.3.22)

Generated: 2026-07-08T20:44:09Z on the release machine. Every block below is raw command output.

## 1. The checkpoint gate is STRUCTURAL (a commit/tag cannot exist without passing it)

```
$ git config core.hooksPath
scripts/hooks

$ cat scripts/hooks/pre-commit
#!/bin/sh
# Supercalm — block commits that contain secrets / private data (see scripts/scan-secrets.mjs).
# Installed by bin/install-hooks (git config core.hooksPath scripts/hooks).
SUPERCALM_SCAN_PHASE=commit exec node scripts/scan-secrets.mjs

$ grep -n 'scan-secrets\|npm test' bin/release
17:node scripts/scan-secrets.mjs >/dev/null   # belt-and-suspenders before anything is tagged for the public
23:  npm test >/dev/null 2>&1 || { echo "bin/release: test suite FAILED — not releasing. (npm test for details)" >&2; exit 1; }
```

A failing scan aborts the commit; bin/release re-runs the scan AND the full suite before bin/version can tag. Therefore each commit/tag hash below is itself evidence its gates passed at its timestamp.

## 2. Release chronology (commit + tag timestamps)

```
67a09b6 2026-07-08T13:30:09-07:00  (tag: v0.3.22) release: v0.3.22
f4ffa08 2026-07-08T13:27:04-07:00  voice brief: clamp at word boundaries (spoken text was cut mid-word)
111cfe3 2026-07-08T13:18:24-07:00  (tag: v0.3.21) release: v0.3.21
98c299a 2026-07-08T13:15:19-07:00  Merge feat/phone-voice
66e14bb 2026-07-08T13:15:18-07:00  phone v2: interactive voice mode, gpt-5.5 spoken briefs, real desktop panels, interaction fixes
f50c208 2026-07-08T12:13:19-07:00  (tag: v0.3.20) release: v0.3.20
bc854b0 2026-07-08T12:10:14-07:00  Merge fix/between-tasks
5408fa9 2026-07-08T12:10:14-07:00  between-tasks fixes: the next card can actually arrive
9fcc79e 2026-07-08T11:37:53-07:00  ledger: phone companion view shipped (v0.3.19)
3228196 2026-07-08T11:36:33-07:00  release: refuse to cut from a non-main branch (v0.3.19 was tagged on feat/phone and never reached installs)
bec4ec3 2026-07-08T11:36:33-07:00  Merge feat/phone: phone companion view
```

## 3. Fresh scan execution (this audit)

```
$ date -u && node scripts/scan-secrets.mjs
Wed Jul  8 20:44:12 UTC 2026
✓ secret-scan clean (253 files)
```

## 4. Third-party execution evidence: GitHub Actions (scan step runs in CI on every push)

```
v0.3.21 → 111cfe3b0619954c1e48bd8c8ad10bc405ab36d1
  run 28972842686 completed success created 2026-07-08T20:18:29Z
v0.3.22 → 67a09b63092694affe7b478570c19441bb8cce5e
  run 28973547805 completed success created 2026-07-08T20:30:14Z
```

## 5. Full diff stat + security-relevant hunks (real file contents)

```
 bin/release                 |   6 +
 docs/improve/LEDGER.md      |  14 +++
 package-lock.json           |   4 +-
 package.json                |   8 +-
 src/agents/supervisor.js    |   8 +-
 src/pm_api.js               |   8 +-
 src/voice.js                |  98 +++++++++++++---
 src/voice_brief.js          | 135 ++++++++++++++++++++++
 test/phone_api.test.js      |  57 ++++++++++
 test/project_memory.test.js |  11 ++
 test/voice_brief.test.js    |  58 ++++++++++
 web/agents/supervisor.js    |   6 +
 web/phone.html              |   1 +
 web/phone.js                | 265 ++++++++++++++++++++++++++++++++++----------
 14 files changed, 599 insertions(+), 80 deletions(-)
```

### /api/session/:id/brief response surface (src/voice.js) — brief only, no keys/routes
```js
route('POST', '/api/session/:id/brief', async (req, res, { id: sid }) => {
  const s2 = store.getSession(sid);
  if (!s2) return json(res, 404, { error: 'no such session' });
  let screen = '';
  try { screen = await sessions.snapshot(sid); } catch {}
  const brief = await buildVoiceBrief({
    sessionId: sid,
    project: s2.project_id ? store.getProject(s2.project_id)?.name || 'adhoc' : 'adhoc',
    tool: s2.tool, category: s2.category || 'review',
    summary: s2.summary || s2.title || '', ask: s2.question || '',
    screen, supervisorNote: supervisorNoteFor(sid),
  });
  json(res, 200, { ok: true, brief });
});
```

### Key redaction at every provider read (src/model_providers.js)
```js
50-  if (!redact) return rows;
51:  return rows.map((p) => ({ ...p, api_key: undefined, key_set: !!p.api_key }));
52-}
--
131-  if (!sp) return null;
132:  return redact ? { ...sp, api_key: undefined, key_set: !!sp.api_key } : sp;
133-}
```

### pm_api.js credential surface: none
```
$ grep -cE 'api_key|token|password|secret|Authorization' src/pm_api.js
0
0
```

## 6. Test execution (enumerated)

```
static_path.test ok
project_graph.test ok
knowledge_assets.test ok
supervisor_spec_files.test ok
supervisor_progressive_scope.test ok
supervisor_doc_lifecycle.test ok
supervisor_awareness_guards.test ok
product_audit.test ok
external_recovery.test ok
operator_requirements.test ok
model_catalog_key.test ok
supervisor_architecture_contract.test ok
supervisor_replay.test ok
supervisor_doctrine.test ok
supervisor_send_policy.test ok
update_core.test ok
supervisor_engagement.test ok
project_memory.test ok
supervisor_task_state.test ok
model_providers.test ok
phone_api.test ok
voice_brief.test ok
session_title.test ok
browser_identity.test ok
preview_profiles.test ok
council_context.test ok
agui_session tests passed
suite exit: 0
```
