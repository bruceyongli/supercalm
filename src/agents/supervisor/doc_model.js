function cleanLine(s, max = 500) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sectionKey(title) {
  const t = String(title || '').toLowerCase();
  if (/\bgoal|intent|objective\b/.test(t)) return 'goal';
  if (/\bnow|current|active work|current work\b/.test(t)) return 'currentWork';
  if (/\bremaining|next|later|future|backlog|workstreams?\b/.test(t)) return 'remainingWork';
  if (/\bacceptance|criteria|definition of done|done\b/.test(t)) return 'acceptanceCriteria';
  if (/\bhard rules?|non-negotiables?|constraints?|rules?\b/.test(t)) return 'hardRules';
  if (/\bdecisions?|agreements?|operator\b/.test(t)) return 'decisions';
  if (/\btimeline|history|archived|resolved|verification|evidence|notes?\b/.test(t)) return 'notes';
  return 'unknown';
}

function bulletText(line) {
  const m = String(line || '').match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
  return m ? m[1].trim() : '';
}

function checkbox(line) {
  const m = String(line || '').match(/^\s*(?:[-*]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/);
  if (!m) return null;
  return { text: cleanLine(m[2]), done: m[1].toLowerCase() === 'x' };
}

function itemFromLine(line) {
  const cb = checkbox(line);
  if (cb) return cb;
  const b = bulletText(line);
  if (b) return { text: cleanLine(b), done: null };
  const t = cleanLine(line);
  return t ? { text: t, done: null } : null;
}

function parseSections(markdown) {
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const sections = [];
  let cur = { title: '', depth: 0, key: 'preamble', lines: [] };
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (h) {
      if (cur.title || cur.lines.some((l) => l.trim())) sections.push(cur);
      cur = { title: cleanLine(h[2]), depth: h[1].length, key: sectionKey(h[2]), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.title || cur.lines.some((l) => l.trim())) sections.push(cur);
  return sections;
}

function sectionItems(sections, key) {
  const out = [];
  for (const s of sections) {
    if (s.key !== key) continue;
    for (const line of s.lines) {
      const item = itemFromLine(line);
      if (item) out.push(item);
    }
  }
  return out;
}

function sectionText(sections, key) {
  return sections
    .filter((s) => s.key === key)
    .flatMap((s) => s.lines)
    .map((l) => cleanLine(l))
    .filter(Boolean)
    .join('\n');
}

export function parseSupervisionDoc(markdown) {
  const raw = String(markdown || '');
  const sections = parseSections(raw);
  const acceptanceCriteria = sectionItems(sections, 'acceptanceCriteria');
  const hardRules = sectionItems(sections, 'hardRules').map((x) => x.text);
  const decisions = sectionItems(sections, 'decisions').map((x) => x.text);
  const remainingWork = sectionItems(sections, 'remainingWork').map((x) => x.text);
  const currentWorkItems = sectionItems(sections, 'currentWork').map((x) => x.text);
  const warnings = [];
  if (raw.trim() && !acceptanceCriteria.length) warnings.push('missing-acceptance-criteria');
  if (raw.trim() && sections.some((s) => s.key === 'unknown' && s.title)) warnings.push('unknown-sections');
  return {
    schema: 'supervisor.doc_model',
    raw,
    title: sections.find((s) => s.depth === 1)?.title || '',
    goal: sectionText(sections, 'goal'),
    currentWork: currentWorkItems.join('\n') || sectionText(sections, 'currentWork'),
    remainingWork: remainingWork.join('\n'),
    acceptanceCriteria,
    hardRules,
    decisions,
    notes: sectionText(sections, 'notes'),
    sections: sections.map((s) => ({ title: s.title, key: s.key, depth: s.depth, itemCount: s.lines.filter((l) => itemFromLine(l)).length })),
    warnings,
  };
}

export function criteriaTexts(model) {
  return (model?.acceptanceCriteria || []).map((c) => c.text).filter(Boolean);
}
