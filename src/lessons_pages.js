// Side-effect-free Lessons reader for wiki/MCP context. The full lessons.js module owns distillation and
// HTTP routes; importing that module from wiki.js would also import server.js and start the app in tests.
import { db } from './store.js';
import { helperEnabled } from './project_helpers.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS lessons (
    id            TEXT NOT NULL,
    project_id    TEXT NOT NULL,
    session_id    TEXT,
    kind          TEXT NOT NULL DEFAULT 'skill-fix',
    task_type     TEXT,
    title         TEXT,
    what_worked   TEXT,
    dead_end      TEXT,
    gotcha        TEXT,
    files         TEXT,
    git_sha       TEXT,
    status        TEXT NOT NULL DEFAULT 'candidate',
    reuse_count   INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    fail_count    INTEGER NOT NULL DEFAULT 0,
    confidence    REAL NOT NULL DEFAULT 0,
    source        TEXT NOT NULL DEFAULT 'distilled',
    created_at    TEXT,
    updated_at    TEXT,
    PRIMARY KEY (project_id, id)
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_lessons_project_status ON lessons(project_id, status)');

const _activeSkill = db.prepare("SELECT * FROM lessons WHERE project_id = ? AND status = 'active' AND kind = 'skill-fix' ORDER BY updated_at DESC LIMIT 80");

function lessonToMarkdown(l) {
  const out = [`# ${l.title || l.task_type || 'Lesson'}`, ''];
  if (l.task_type) out.push(`_Task type: ${l.task_type}${l.git_sha ? ` @${l.git_sha}` : ''}_`, '');
  if (l.what_worked) out.push('## What worked', l.what_worked, '');
  if (l.dead_end) out.push("## Dead end - don't", l.dead_end, '');
  if (l.gotcha) out.push('## Gotcha', l.gotcha, '');
  let files = [];
  try { files = JSON.parse(l.files || '[]'); } catch {}
  if (files.length) out.push('## Files', files.map((f) => `- \`${f}\``).join('\n'), '');
  return out.join('\n').trim();
}

export function lessonsPages(pid) {
  if (!pid || !helperEnabled(pid, 'lessons')) return [];
  return _activeSkill.all(pid).map((l) => ({ path: `lessons/${l.id}.md`, title: l.title || l.task_type || 'Lesson', content: lessonToMarkdown(l), source: 'lesson' }));
}
