import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DOD_FILE_CHAR_LIMIT = 30000;
const SKIP_DIR_RX = /^(\.git|node_modules|dist|build|coverage|\.next|\.cache|\.venv|__pycache__|vendor|tmp|logs|data|verify-\d{4}(?:[-_].*)?)$/i;
export const DOD_RX = /^(.*DEFINITION[_-]?OF[_-]?DONE.*|.*ACCEPTANCE.*|.*CONTRACT.*|.*SPEC.*|DESIGN[_-]?v?\d*.*|.*ARCHITECTURE.*|.*REQUIREMENTS.*|.*ROADMAP.*|.*[_-]DONE)\.md$/i;
const GENERIC_STEM_RX = /^(architecture|requirements|roadmap|spec|contract|acceptance|design)$/i;
const NAME_CHAR_RX = /[a-z0-9_.-]/i;

function containsName(query, name) {
  if (!query || !name) return false;
  let i = query.indexOf(name);
  while (i !== -1) {
    const before = i > 0 ? query[i - 1] : '';
    const after = query[i + name.length] || '';
    if (!NAME_CHAR_RX.test(before) && !NAME_CHAR_RX.test(after)) return true;
    i = query.indexOf(name, i + 1);
  }
  return false;
}

function scoreCandidate(relPath, query = '') {
  const s = relPath.replace(/\\/g, '/').toLowerCase();
  const base = s.split('/').pop();
  const stem = base.replace(/\.md$/i, '');
  const q = String(query || '').toLowerCase();
  let score = 0;
  if (q.includes(s)) score += 320;
  else if (containsName(q, base)) score += 280;
  else if (!GENERIC_STEM_RX.test(stem) && containsName(q, stem)) score += 240;
  if (/definition[_-]?of[_-]?done|acceptance/.test(s)) score += 120;
  if (/contract/.test(s)) score += 110;
  if (/spec/.test(s)) score += 90;
  if (/requirements|roadmap|architecture|design/.test(s)) score += 70;
  if (/(^|\/)docs\/specs\//.test(s)) score += 60;
  if (!s.includes('/')) score += 5;
  return score;
}

function explicitlyMentioned(relPath, query = '') {
  const s = relPath.replace(/\\/g, '/').toLowerCase();
  const base = s.split('/').pop();
  const stem = base.replace(/\.md$/i, '');
  const q = String(query || '').toLowerCase();
  return !!q && (q.includes(s) || containsName(q, base) || (!GENERIC_STEM_RX.test(stem) && containsName(q, stem)));
}

export function dodFiles(projectPath, { maxDepth = 6, limit = 3, query = '' } = {}) {
  if (!projectPath) return [];
  const out = [];
  const walk = (dir, rel, depth) => {
    if (depth > maxDepth || out.length > 100) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const relPath = rel ? join(rel, ent.name) : ent.name;
      if (ent.isDirectory()) {
        if (!SKIP_DIR_RX.test(ent.name)) walk(join(dir, ent.name), relPath, depth + 1);
        continue;
      }
      if (!ent.isFile() || !DOD_RX.test(ent.name)) continue;
      try {
        const st = statSync(join(dir, ent.name));
        out.push({ name: relPath, mtime: st.mtimeMs, score: scoreCandidate(relPath, query) });
      } catch {}
    }
  };
  walk(projectPath, '', 0);
  const sorted = out.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  const mentioned = sorted.filter((f) => explicitlyMentioned(f.name, query));
  return (mentioned.length ? mentioned : sorted).slice(0, limit);
}

export function dodMtime(projectPath) {
  const fs = dodFiles(projectPath);
  return fs.length ? Math.max(...fs.map((f) => f.mtime)) : 0;
}

export function findDoD(projectPath, { charLimit = DOD_FILE_CHAR_LIMIT, query = '' } = {}) {
  const files = dodFiles(projectPath, { query });
  const parts = [];
  for (const f of files) {
    try { parts.push(`### ${f.name}\n` + readFileSync(join(projectPath, f.name), 'utf8').slice(0, charLimit)); } catch {}
  }
  return { text: parts.join('\n\n'), files: files.map((f) => f.name) };
}
