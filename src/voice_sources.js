// Source-grounded voice conversations for session reports. Reports often carry the most useful
// detail in linked Markdown or research artifacts; the ordinary attention card intentionally keeps
// that detail compact. This module turns only files approved by sessions.resolveSessionFile into a
// small, queryable source pack. It never broadens file access or sends paths to the browser.

import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.csv', '.tsv', '.yaml', '.yml', '.toml', '.log', '.rst',
]);
const BROAD_DETAIL_RX = /\b(?:all|detail|details|document|documents|docs|file|files|plan|proposal|research|source|sources|tell me more|tell me about|walk me through|go deeper|explain|how does|what does)\b/i;
const STOP_WORDS = new Set('a about an and are as at be been but by can could did do does for from had has have here how i in into is it its me my of on or our should so tell that the their them there these they this those to us was we were what when where which who why will with would you your'.split(' '));

function cleanTarget(value) {
  let target = String(value || '').trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  target = target.replace(/\s+["'][^"']*["']\s*$/, '').replace(/#(?:L?\d.*)?$/, '').trim();
  try { target = decodeURIComponent(target); } catch {}
  return target;
}

function isTextReference(target) {
  if (!target || /^(?:https?|data|mailto|javascript):/i.test(target)) return false;
  return TEXT_EXTENSIONS.has(extname(target).toLowerCase());
}

export function extractVoiceSourceReferences(text) {
  const input = String(text || '');
  const found = [];
  const seen = new Set();
  const add = (target, label = '') => {
    target = cleanTarget(target);
    if (!isTextReference(target) || seen.has(target)) return;
    seen.add(target);
    found.push({ target, label: String(label || '').replace(/\s+/g, ' ').trim().slice(0, 120) });
  };

  // Markdown links retain labels even when the target contains spaces and is wrapped in angle brackets.
  for (const match of input.matchAll(/\[([^\]\n]+)\]\((<[^>\n]+>|[^)\n]+)\)/g)) add(match[2], match[1]);

  // Agents also paste bare absolute or relative artifact paths. Deliberately require a supported text
  // extension; images, videos, executables, directories, and ordinary slash-heavy prose stay out.
  const bare = /(?:^|[\s`'"(])((?:~\/|\/|\.\.?\/)?[A-Za-z0-9_@.+-]+(?:\/[A-Za-z0-9_@.+ -]+)+\.(?:md|markdown|txt|jsonc?|csv|tsv|ya?ml|toml|log|rst))(?=$|[.\s`'",;:)\]}])/gim;
  for (const match of input.matchAll(bare)) add(match[1]);
  return found;
}

function cleanContent(value) {
  return String(value || '')
    .replace(/^---\s*\n[\s\S]{0,3000}?\n---\s*\n/, '')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function plainTitle(value, fallback) {
  return String(value || fallback || '')
    .replace(/^#+\s*/, '')
    .replace(/[*_`[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'Report document';
}

function chunkSection(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const paragraphs = text.split(/\n{2,}/).filter(Boolean);
  const chunks = [];
  let current = '';
  const push = () => { if (current.trim()) chunks.push(current.trim()); current = ''; };
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      push();
      for (let start = 0; start < paragraph.length; start += maxChars) chunks.push(paragraph.slice(start, start + maxChars).trim());
    } else if (!current || current.length + paragraph.length + 2 <= maxChars) {
      current += `${current ? '\n\n' : ''}${paragraph}`;
    } else {
      push();
      current = paragraph;
    }
  }
  push();
  return chunks;
}

export function splitVoiceSourceSections(content, sourceName = 'Report document', maxChars = 2200) {
  const clean = cleanContent(content);
  if (!clean) return [];
  const lines = clean.split('\n');
  const sections = [];
  let heading = sourceName;
  let body = [];
  const flush = () => {
    const value = body.join('\n').trim();
    if (value) {
      const chunks = chunkSection(value, maxChars);
      chunks.forEach((text, index) => sections.push({
        heading: chunks.length > 1 ? `${heading} (part ${index + 1})` : heading,
        text,
      }));
    }
    body = [];
  };
  for (const line of lines) {
    const match = line.match(/^#{1,4}\s+(.+?)\s*#*$/);
    if (match) {
      flush();
      heading = plainTitle(match[1], sourceName);
    } else body.push(line);
  }
  flush();
  return sections.length ? sections : [{ heading: sourceName, text: clean.slice(0, maxChars) }];
}

export async function buildVoiceSourcePack({
  session,
  reportText,
  resolveFile,
  maxSources = 8,
  maxFileBytes = 800_000,
  maxFileChars = 60_000,
  maxTotalChars = 140_000,
} = {}) {
  if (!session || typeof resolveFile !== 'function') return { sources: [], totalChars: 0 };
  const references = extractVoiceSourceReferences(reportText).slice(0, Math.max(1, maxSources * 2));
  const sources = [];
  const seenTargets = new Set();
  let totalChars = 0;
  // Resolve sequentially: the authorization layer may inspect a large native transcript, so a report
  // with several links must not start redundant scans in parallel.
  for (const reference of references) {
    if (sources.length >= maxSources || totalChars >= maxTotalChars) break;
    let resolved;
    try { resolved = await resolveFile(session, reference.target); } catch { continue; }
    if (!resolved?.target || seenTargets.has(resolved.target)) continue;
    seenTargets.add(resolved.target);
    let info;
    try { info = await stat(resolved.target); } catch { continue; }
    if (!info.isFile() || info.size <= 0 || info.size > maxFileBytes || !TEXT_EXTENSIONS.has(extname(resolved.target).toLowerCase())) continue;
    let content;
    try { content = await readFile(resolved.target, 'utf8'); } catch { continue; }
    if (!content || content.includes('\0')) continue;
    content = content.slice(0, Math.min(maxFileChars, maxTotalChars - totalChars));
    const firstHeading = content.match(/^#\s+(.+)$/m)?.[1];
    const name = plainTitle(reference.label || firstHeading, basename(resolved.target));
    const sections = splitVoiceSourceSections(content, name);
    if (!sections.length) continue;
    const charCount = sections.reduce((sum, section) => sum + section.text.length, 0);
    totalChars += charCount;
    sources.push({ name, fileName: basename(resolved.target), charCount, sections });
  }
  return { sources, totalChars };
}

function termsFor(query) {
  return [...new Set(String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [])]
    .filter((term) => !STOP_WORDS.has(term));
}

function scoreSection(source, section, terms, index) {
  const title = `${source.name} ${source.fileName} ${section.heading}`.toLowerCase();
  const body = section.text.toLowerCase();
  let score = Math.max(0, 4 - index * 0.08);
  for (const term of terms) {
    if (title.includes(term)) score += 12;
    const count = body.split(term).length - 1;
    score += Math.min(8, count) * 1.5;
  }
  return score;
}

export function voiceSourceContext(pack, query = '', { maxChars = 10000 } = {}) {
  const sources = pack?.sources || [];
  if (!sources.length) return '';
  const terms = termsFor(query);
  const broad = !terms.length || BROAD_DETAIL_RX.test(query);
  const ranked = [];
  sources.forEach((source, sourceIndex) => source.sections.forEach((section, sectionIndex) => ranked.push({
    source,
    section,
    sourceIndex,
    sectionIndex,
    score: scoreSection(source, section, terms, sectionIndex),
  })));
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.sourceIndex !== b.sourceIndex) return a.sourceIndex - b.sourceIndex;
    return a.sectionIndex - b.sectionIndex;
  });

  // Broad questions get at least one useful section from every linked source before additional depth.
  const ordered = broad
    ? [...sources.map((source) => ranked.find((item) => item.source === source)).filter(Boolean), ...ranked]
    : ranked;
  const used = new Set();
  const blocks = [];
  let size = 0;
  for (const item of ordered) {
    const key = `${item.sourceIndex}:${item.sectionIndex}`;
    if (used.has(key)) continue;
    const block = `SOURCE: ${item.source.name}\nSECTION: ${item.section.heading}\n${item.section.text}`;
    if (size && size + block.length + 2 > maxChars) continue;
    blocks.push(block.slice(0, maxChars - size));
    size += block.length + 2;
    used.add(key);
    if (size >= maxChars || (!broad && blocks.length >= 5)) break;
  }
  return blocks.join('\n\n');
}

export function voiceSourceSummary(pack, maxNames = 3) {
  const sources = pack?.sources || [];
  return {
    count: sources.length,
    names: sources.slice(0, maxNames).map((source) => source.name),
  };
}
