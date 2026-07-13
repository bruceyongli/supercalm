// claude transcript identity — locks the cross-session story-bleed fix: with several live claude
// sessions in ONE cwd, the old picker ("largest .jsonl touched since session start − 2min") rendered
// the biggest transcript into EVERY session's story — three concurrent sessions all showed the same
// 183MB conversation (s_087cf6e228's) on 2026-07-13. Order now: hook-bound path → heuristic minus
// other sessions' bound transcripts, preferring files CREATED in the session's launch window.
// Pure-logic tests + a bound-path FS check + source-locks on the wiring.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pickClaudeTranscript, findClaudeLog, claudeSlug } from '../src/claude_transcripts.js';

const MIN = 60e3;
const T0 = 1_783_923_141_097; // s_2587ee0851's real launch ms — the incident scenario

// The incident, as candidates: a 183MB long-lived sibling transcript (born days earlier, still hot)
// vs the session's own fresh, far smaller file (born seconds after launch).
const bigOld = { p: '/p/92c63f25.jsonl', size: 183_429_755, mtimeMs: T0 + 70 * MIN, birthtimeMs: T0 - 6 * 24 * 60 * MIN };
const ownFresh = { p: '/p/a733ce70.jsonl', size: 957_442, mtimeMs: T0 + 60 * MIN, birthtimeMs: T0 + 9_000 };

// ---- fresh-birth tier: the session's own file wins even though the sibling is 190× bigger ----
assert.equal(
  pickClaudeTranscript([bigOld, ownFresh], { started_at: T0 }),
  ownFresh.p,
  'a transcript created at launch beats a bigger long-lived sibling',
);

// ---- claimed exclusion: a transcript another session bound is never picked here ----
const bigOld0 = { ...bigOld, birthtimeMs: 0 };   // filesystems without creation time
const ownFresh0 = { ...ownFresh, birthtimeMs: 0 };
assert.equal(
  pickClaudeTranscript([bigOld0, ownFresh0], { started_at: T0 }, { claimed: [bigOld0.p] }),
  ownFresh0.p,
  'sibling-bound transcript is excluded even without birthtime support',
);
assert.equal(
  pickClaudeTranscript([bigOld0], { started_at: T0 }, { claimed: new Set([bigOld0.p]) }),
  null,
  'everything claimed by others → null (story falls back to the honestly-attributed spine)',
);

// ---- legacy semantics preserved for unbound sessions on birthtime-less filesystems ----
assert.equal(
  pickClaudeTranscript([bigOld0, ownFresh0], { started_at: T0 }),
  bigOld0.p,
  'no binding, no claims, no birthtimes → old behavior (largest recently-touched) still stands',
);
const stale = { p: '/p/old.jsonl', size: 9e9, mtimeMs: T0 - 10 * MIN, birthtimeMs: 0 };
assert.equal(
  pickClaudeTranscript([stale, ownFresh0], { started_at: T0 }),
  ownFresh0.p,
  'files untouched since start − 2min stay excluded (legacy mtime window)',
);
assert.equal(
  pickClaudeTranscript([bigOld0, ownFresh0], {}),
  bigOld0.p,
  'no started_at → largest of everything (legacy)',
);
assert.equal(pickClaudeTranscript([], { started_at: T0 }), null);

// ---- findClaudeLog: a hook-bound path short-circuits the heuristic entirely ----
const dir = mkdtempSync(join(tmpdir(), 'aios-claude-transcripts-'));
const boundFile = join(dir, 'bound.jsonl');
writeFileSync(boundFile, '{"type":"user"}\n');
assert.equal(
  await findClaudeLog('/nonexistent/cwd', { claude_transcript: boundFile, started_at: T0 }),
  boundFile,
  'bound transcript wins even when the cwd slug dir does not exist',
);
assert.equal(
  await findClaudeLog('/nonexistent/cwd', { claude_transcript: join(dir, 'gone.jsonl'), started_at: T0 }),
  null,
  'stale binding falls through to the heuristic (here: no slug dir → null)',
);
assert.equal(claudeSlug('/Users/bb1/aios'), '-Users-bb1-aios');

// ---- source-locks: the wiring that makes the module matter ----
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const storySrc = read('../src/story_api.js');
assert.ok(storySrc.includes("from './claude_transcripts.js'"), 'story_api uses the shared locator');
assert.ok(storySrc.includes('otherClaudeTranscripts(sid)'), 'story_api passes the sibling-claimed set');
const hooksSrc = read('../src/hooks.js');
assert.ok(hooksSrc.includes('claude_transcript') && hooksSrc.includes('transcript-bind'), 'hooks.js persists the bound transcript');
assert.ok(hooksSrc.includes('CLAUDE_PROJECTS_ROOT'), 'hooks.js confines bindable paths to ~/.claude/projects');
const hookSh = read('../scripts/aios-claude-hook.sh');
assert.ok(hookSh.includes('transcript_path'), 'hook script forwards transcript_path');
const storeSrc = read('../src/store.js');
assert.ok(storeSrc.includes("'claude_transcript TEXT'") && storeSrc.includes("'claude_transcript'"), 'store migrates + whitelists the column');

console.log('claude_transcripts: all assertions passed');
