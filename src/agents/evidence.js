import net from 'node:net';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, writeFile, mkdir, readdir, stat, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { LOG_DIR, DATA_DIR } from '../config.js';
import { getProject, messagesFor } from '../store.js';
import { stripAnsi } from '../util.js';
import { projectGraphBrief } from '../project_graph_core.js';
import { activePreviewProfiles } from '../preview_profiles.js';
import { normalizeProductAuditSpec } from './product_audit.js';

// Read-only evidence gathering for panel agents: git diff/status, terminal tail, recent messages,
// and an optional headless-Chrome preview screenshot. Extracted verbatim from the v2 supervisor so
// every agent shares one implementation (and one set of timeout/SIGKILL backstops).

const exec = promisify(execFile);
const SHOT_TIMEOUT_MS = Number(process.env.AIOS_SUPERVISOR_SHOT_TIMEOUT_MS || 25000);
const SHOT_LOAD_WAIT_MS = Number(process.env.AIOS_SUPERVISOR_SHOT_LOAD_MS || 6000);
const SHOT_SETTLE_MS = Number(process.env.AIOS_SUPERVISOR_SHOT_SETTLE_MS || 700);
const CHROME = process.env.AIOS_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOT_DIR = join(DATA_DIR, 'supervisor');
const MAX_SHOTS_PER_SESSION = 20;

// Paths an agent might edit to fake passing checks (test files, CI config, fixtures).
export const TEST_FILE_RX = /(^|\/)(tests?|spec|specs|__tests__|__mocks__|e2e|fixtures?|\.github|ci|cypress)\/|\.(test|spec)\.[jt]sx?$|(^|\/)(jest|vitest|playwright|cypress|karma|mocha|\.eslintrc|tsconfig|.*\.config)\.[a-z.]+$/i;

export function cleanText(s, max = 16000) {
  return stripAnsi(String(s || ''))
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[│╭╮╰╯─━┃▌▐]/g, ' ').replace(/\s+$/g, ''))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .slice(-max);
}

export async function terminalTail(session_id, max = 16000) {
  // Read only the tail of the (potentially huge, multi-MB) session log, not the whole file — this
  // runs on every supervisor tick. Pull ~4x the char budget in raw bytes (ANSI-stripping shrinks it)
  // with a 64KB floor, then clean + slice to `max`.
  const path = join(LOG_DIR, session_id + '.log');
  try {
    const fh = await open(path, 'r');
    try {
      const { size } = await fh.stat();
      const want = Math.min(size, Math.max(max * 4, 65536));
      const buf = Buffer.alloc(want);
      await fh.read(buf, 0, want, size - want);
      return cleanText(buf.toString('utf8'), max);
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}

export function tailStr(s, max = 2000) {
  const t = String(s || '').replace(/\r/g, '');
  return t.length > max ? t.slice(t.length - max) : t;
}

function mkGit(cwd) {
  return async (args, max) => {
    try {
      const r = await exec('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 6000, killSignal: 'SIGKILL' });
      return String(r.stdout || '').slice(0, max);
    } catch {
      return '';
    }
  };
}

// Current HEAD sha — the supervisor captures this as its baseline so later reviews can diff
// "work done since I started watching", including already-committed work.
export async function gitHead(cwd) {
  if (!cwd) return null;
  const sha = (await mkGit(cwd)(['rev-parse', 'HEAD'], 64)).trim();
  return sha || null;
}

// A session's project path may be a WORKSPACE that holds several sibling git repos (a monorepo-of-repos
// layout, e.g. ~/openhand/share/{openhand,openhand-web,...}) rather than a repo itself. A plain git read at
// the root then sees nothing -> the supervisor is BLIND to all the work and loops demanding evidence it can't
// read. Detect the sub-repos the agent ACTUALLY changed (dirty tree or a recent commit) and aggregate their
// evidence, labeled per repo and bounded, so the reviewer can see + verify the real work. Fail-safe -> null.
const MULTI_REPO_WINDOW_MS = Number(process.env.AIOS_SUPERVISOR_MULTIREPO_WINDOW_MS || 18 * 3600 * 1000); // committed this recently -> active
const MULTI_REPO_DIRTY_WINDOW_MS = Number(process.env.AIOS_SUPERVISOR_MULTIREPO_DIRTY_WINDOW_MS || 72 * 3600 * 1000); // dirty AND committed within 3d -> active (skip 2-week-stale dirty cruft)
const MAX_SUB_REPOS = Number(process.env.AIOS_SUPERVISOR_MULTIREPO_MAX || 4);
async function isRepoDir(dir) { try { await stat(join(dir, '.git')); return true; } catch { return false; } }
async function multiRepoEvidence(cwd) {
  let kids;
  try { kids = (await readdir(cwd, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).slice(0, 40); }
  catch { return null; }
  const repos = [];
  for (const n of kids) { if (await isRepoDir(join(cwd, n))) repos.push(n); }
  if (!repos.length) return null;
  const now = Date.now();
  const scored = await Promise.all(repos.map(async (name) => {
    const g = mkGit(join(cwd, name));
    const [porcelain, ct] = await Promise.all([g(['status', '--porcelain'], 2000), g(['log', '-1', '--format=%ct'], 32)]);
    const dirty = !!porcelain.trim();
    const last = (Number(ct.trim()) || 0) * 1000;
    return { name, g, dirty, last, active: (last && now - last < MULTI_REPO_WINDOW_MS) || (dirty && last && now - last < MULTI_REPO_DIRTY_WINDOW_MS) };
  }));
  let active = scored.filter((r) => r.active);
  if (!active.length) { const mr = scored.filter((r) => r.last).sort((a, b) => b.last - a.last)[0]; if (mr) active = [mr]; } // never fully blind: fall back to the single most-recently-committed repo
  active = active.sort((a, b) => (b.last - a.last) || (Number(b.dirty) - Number(a.dirty))).slice(0, MAX_SUB_REPOS);
  if (!active.length) return null;
  const acc = { status: [], stat: [], diff: [], commits: [], committed_stat: [], committed_diff: [], names: [] };
  for (const r of active) {
    const g = r.g;
    const tag = `### ${r.name}/`;
    const [status, stat2, diff, names] = await Promise.all([
      g(['status', '--short'], 3000), g(['diff', '--no-ext-diff', '--stat'], 3000),
      g(['diff', '--no-ext-diff', '--find-renames', '--unified=12'], 6000), g(['diff', '--no-ext-diff', '--name-only'], 3000),
    ]);
    // No per-sub-repo baseline (the container HEAD doesn't exist) -> show recently-committed work as a bounded
    // last-~8-commits slice (falls back to the full history if the repo has fewer commits).
    const commits = await g(['log', '--oneline', '-15'], 2500);
    const base = (await g(['rev-parse', 'HEAD~8'], 64)).trim() || (await g(['rev-list', '--max-parents=0', 'HEAD'], 64)).trim();
    let cstat = '', cdiff = '', cnames = '';
    if (base) [cstat, cdiff, cnames] = await Promise.all([
      g(['diff', '--no-ext-diff', '--stat', base, 'HEAD'], 3000),
      g(['diff', '--no-ext-diff', '--find-renames', '--unified=12', base, 'HEAD'], 8000),
      g(['diff', '--no-ext-diff', '--name-only', base, 'HEAD'], 3000),
    ]);
    if (status) acc.status.push(`${tag}\n${status}`);
    if (stat2) acc.stat.push(`${tag}\n${stat2}`);
    if (diff) acc.diff.push(`${tag}\n${diff}`);
    if (commits) acc.commits.push(`${tag} recent commits\n${commits}`);
    if (cstat) acc.committed_stat.push(`${tag}\n${cstat}`);
    if (cdiff) acc.committed_diff.push(`${tag} last ~8 commits\n${cdiff}`);
    acc.names.push(`${names}\n${cnames}`);
  }
  const j = (a, max) => a.join('\n\n').slice(0, max);
  const touched = acc.names.join('\n').split('\n').map((s) => s.trim()).filter(Boolean).filter((p) => TEST_FILE_RX.test(p));
  if (!acc.status.length && !acc.diff.length && !acc.committed_diff.length && !acc.commits.length) return null;
  return {
    multi_repo: active.map((r) => r.name),
    status: j(acc.status, 8000), stat: j(acc.stat, 8000), diff: j(acc.diff, 18000),
    commits: j(acc.commits, 5000), committed_stat: j(acc.committed_stat, 8000), committed_diff: j(acc.committed_diff, 18000),
    touched_test_files: [...new Set(touched)].slice(0, 40),
  };
}

async function gitEvidence(cwd, { baseRef } = {}) {
  const git = mkGit(cwd);
  const inside = await git(['rev-parse', '--is-inside-work-tree'], 16);
  if (inside.trim() !== 'true') return multiRepoEvidence(cwd); // workspace of sibling repos -> aggregate the active ones
  const [status, statOut, diff, names] = await Promise.all([
    git(['status', '--short'], 8000),
    git(['diff', '--no-ext-diff', '--stat'], 8000),
    git(['diff', '--no-ext-diff', '--find-renames', '--unified=20'], 16000),
    git(['diff', '--no-ext-diff', '--name-only'], 8000),
  ]);

  // Committed work the reviewer would otherwise be blind to: once the agent commits/pushes, the
  // working-tree diff above is empty. With a baseline we show everything done since (diff + log);
  // without one we still surface a recent slice of history for context.
  let commits = '';
  let committed_stat = '';
  let committed_diff = '';
  let committed_names = '';
  if (baseRef) {
    [commits, committed_stat, committed_diff, committed_names] = await Promise.all([
      git(['log', '--oneline', `${baseRef}..HEAD`], 4000),
      git(['diff', '--no-ext-diff', '--stat', baseRef, 'HEAD'], 8000),
      git(['diff', '--no-ext-diff', '--find-renames', '--unified=20', baseRef, 'HEAD'], 16000),
      git(['diff', '--no-ext-diff', '--name-only', baseRef, 'HEAD'], 8000),
    ]);
  } else {
    commits = await git(['log', '--oneline', '-20'], 4000);
  }

  if (!status && !statOut && !diff && !committed_diff && !commits) return null;
  const touched_test_files = (String(names || '') + '\n' + String(committed_names || ''))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => TEST_FILE_RX.test(p));
  return { status, stat: statOut, diff, commits, committed_stat, committed_diff, touched_test_files: [...new Set(touched_test_files)].slice(0, 40) };
}

// ---------------------------------------------------------------------------
// Cited-source resolver — DIG FOR TRUTH instead of trusting the agent's paraphrase.
// When an agent refuses citing a specific rule/section ("HR-1"), file (PRINCIPLES.md), or spec, the
// supervisor must read the ACTUAL on-disk text and verify the claim against it — not argue rhetorically or
// take the agent's word. (s_e8b74301f6: the agent refused to start a daemon citing HR-1; HR-1 LITERALLY
// said doing exactly that on the operator's own devices "is fine and expected, not a violation" — the agent
// inverted its own rule, and the supervisor never read the file.) Bounded + best-effort; repo = untrusted
// DATA. Returns a formatted block of the cited sources, or '' when nothing checkable is referenced.
const CITE_MAX_BLOCKS = 4;
const CITE_MAX_BYTES = 2400;     // per source section
const CITE_TOTAL_BYTES = 9000;   // across all blocks
const WELL_KNOWN_DOCS = ['PRINCIPLES.md', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'HANDOFF.md', 'CONTRIBUTING.md', 'SECURITY.md', 'GOAL.md', 'ARCHITECTURE.md'];
const DOC_EXT_RX = /\b([\w.\/-]{1,80}\.(?:md|markdown|mdx|txt|ya?ml|json|toml|ini|cfg|conf|env|rules?))\b/gi;
const RULE_TOKEN_RX = /\b([A-Z]{1,5}-\d{1,4})\b/g; // HR-1, R-12, SEC-3 — a named rule/principle/section id

function relTo(cwd, file) { return cwd && file.startsWith(cwd) ? file.slice(cwd.length).replace(/^\//, '') : file; }

function extractCitations(text) {
  const t = String(text || '');
  const rules = new Set();
  for (const m of t.matchAll(RULE_TOKEN_RX)) rules.add(m[1]);
  const files = new Set();
  for (const m of t.matchAll(DOC_EXT_RX)) { const f = m[1].replace(/^\.\//, ''); if (f.length <= 80) files.add(f); }
  for (const d of WELL_KNOWN_DOCS) if (new RegExp('\\b' + d.replace('.', '\\.') + '\\b', 'i').test(t)) files.add(d);
  return { rules: [...rules].slice(0, 6), files: [...files].slice(0, 6) };
}

// Pull the markdown section (heading + body up to the next same-or-shallower heading) containing `lineNo`.
function sectionAround(content, lineNo) {
  const lines = content.split('\n');
  let h = Math.max(0, Math.min(lines.length - 1, (lineNo | 0) - 1));
  while (h > 0 && !/^#{1,6}\s/.test(lines[h])) h--;       // back up to the enclosing heading
  const depth = (lines[h].match(/^#+/) || ['#'])[0].length;
  let end = h + 1;
  while (end < lines.length && end - h < 36) { const m = lines[end].match(/^(#{1,6})\s/); if (m && m[1].length <= depth) break; end++; }
  return lines.slice(h, end).join('\n');
}

export async function citedSources(cwd, text, { timeoutMs = 4000 } = {}) {
  if (!cwd || process.env.AIOS_SUPERVISOR_CITED_SOURCES === '0') return '';
  const { rules, files } = extractCitations(text);
  if (!rules.length && !files.length) return '';
  const SKIP = ['--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist', '--exclude-dir=build', '--exclude-dir=.next', '--exclude-dir=vendor', '--exclude-dir=coverage', '--exclude-dir=.cache'];
  const INC = ['--include=*.md', '--include=*.markdown', '--include=*.mdx', '--include=*.txt'];
  const blocks = [];
  const seen = new Set();
  let total = 0;
  const push = (label, body) => {
    if (!body || blocks.length >= CITE_MAX_BLOCKS || total >= CITE_TOTAL_BYTES) return;
    const b = String(body).slice(0, CITE_MAX_BYTES).trim();
    if (!b || seen.has(label)) return;
    seen.add(label); blocks.push(`--- ${label} ---\n${b}`); total += b.length;
  };
  // A token like "HR-1" can appear in several files (here: the authoritative PRINCIPLES.md AND an unrelated
  // experiments/synthesis.md with its own "HR-1"). Rank hits so we quote the AUTHORITATIVE source: prefer a
  // well-known doc or a file the agent named, and demote experiment/archive/scratch/test copies.
  const citedBase = new Set([...files].map((f) => f.split('/').pop()));
  const score = (path) => {
    let s = 0; const base = path.split('/').pop();
    if (WELL_KNOWN_DOCS.includes(base)) s += 3;
    if (citedBase.has(base)) s += 2;
    if (/\/(experiments?|archive|attic|old|drafts?|scratch|examples?|\.verify[\w-]*)\//i.test(path)) s -= 4;
    if (/\/(tests?|specs?|__tests__|fixtures?)\//i.test(path)) s -= 1;
    return s;
  };
  // 1) named rule/section tokens -> grep the docs, quote the actual section from the BEST-ranked hit.
  for (const r of rules) {
    if (blocks.length >= CITE_MAX_BLOCKS) break;
    try {
      const { stdout } = await exec('grep', ['-rInF', ...INC, ...SKIP, '-e', r, cwd], { timeout: timeoutMs, maxBuffer: 4_000_000 });
      const hits = stdout.split('\n').filter(Boolean)
        .map((l) => { const m = l.match(/^(.*?):(\d+):/); return m ? { file: m[1], line: Number(m[2]) } : null; })
        .filter(Boolean);
      if (!hits.length) continue;
      hits.sort((a, b) => score(b.file) - score(a.file)); // stable: ties keep grep order (first occurrence)
      const best = hits[0];
      const content = await readFile(best.file, 'utf8').catch(() => '');
      if (content) push(`${relTo(cwd, best.file)} › ${r}`, sectionAround(content, best.line));
    } catch { /* grep exits 1 on no match -> skip */ }
  }
  // 2) doc filenames -> find + read head (skip ones already pulled via a rule hit).
  for (const f of files) {
    if (blocks.length >= CITE_MAX_BLOCKS || total >= CITE_TOTAL_BYTES) break;
    try {
      const base = f.split('/').pop();
      const { stdout } = await exec('find', [cwd, '-type', 'f', '-name', base, '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*'], { timeout: timeoutMs, maxBuffer: 1_000_000 });
      const file = stdout.split('\n').find(Boolean);
      if (!file) continue;
      const rel = relTo(cwd, file);
      if ([...seen].some((l) => l.startsWith(rel))) continue; // already quoted a section of this file
      const content = await readFile(file, 'utf8').catch(() => '');
      if (content) push(rel, content);
    } catch { /* skip */ }
  }
  return blocks.length ? blocks.join('\n\n') : '';
}

async function pruneShots(dir) {
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - MAX_SHOTS_PER_SESSION))) {
      await unlink(join(dir, f)).catch(() => {});
    }
  } catch {}
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function cdpPageWs(port) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (r.ok) {
        const page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {}
    await delay(150);
  }
  throw new Error('chrome devtools endpoint not ready');
}

function cdpValue(result) {
  return result?.result?.value ?? null;
}

async function waitForLoad(loadedRef) {
  const until = Date.now() + SHOT_LOAD_WAIT_MS;
  while (!loadedRef() && Date.now() < until) await delay(100);
}

async function loginFormVisible(call) {
  try {
    return !!cdpValue(await call('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const txt = (document.body?.innerText || '').toLowerCase();
        const inputs = [...document.querySelectorAll('input')].filter((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
        });
        return inputs.length > 0 && /\\b(log in|login|sign in|access code|passcode|password)\\b/.test(txt);
      })()`,
    }));
  } catch {
    return false;
  }
}

async function fillPasscodeForm(call, auth) {
  if (!auth?.passcode) return false;
  try {
    const r = await call('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(${async ({ username, passcode }) => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.disabled && !el.readOnly;
        };
        const hay = (el) => [el.type, el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute('aria-label')]
          .filter(Boolean).join(' ').toLowerCase();
        const inputs = [...document.querySelectorAll('input')].filter(visible);
        if (!inputs.length) return { attempted: false };

        const email = inputs.find((el) => /email|e-mail|username|user|login/.test(hay(el))) || (username ? inputs[0] : null);
        const pass = inputs.find((el) => el !== email && /access|code|passcode|pass\\s*code|password|token/.test(hay(el)))
          || inputs.find((el) => el !== email && (el.type === 'password' || el.type === 'text'))
          || (!username && inputs[0]);
        if (!pass) return { attempted: false };

        const setValue = (el, value) => {
          el.focus();
          const proto = Object.getPrototypeOf(el);
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc?.set) desc.set.call(el, value);
          else el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };

        if (username && email) setValue(email, username);
        setValue(pass, passcode);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const root = pass.closest('form') || email?.closest('form') || document;
        const buttons = [...root.querySelectorAll('button,input[type="submit"],[role="button"]')].filter(visible);
        const submit = buttons.find((el) => /log\\s*in|login|sign\\s*in|continue|submit|unlock|enter/.test((el.innerText || el.value || el.getAttribute('aria-label') || '').toLowerCase()))
          || buttons.find((el) => el.type === 'submit')
          || buttons[0];
        if (submit) {
          submit.click();
        } else if (root.requestSubmit) {
          root.requestSubmit();
        } else {
          pass.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        }
        return { attempted: true };
      }})(${JSON.stringify({ username: auth.username || '', passcode: auth.passcode })})`,
    });
    return !!cdpValue(r)?.attempted;
  } catch {
    return false;
  }
}

async function waitForLoginResult(call, loadedRef) {
  const until = Date.now() + SHOT_LOAD_WAIT_MS;
  while (Date.now() < until) {
    if (loadedRef() || !(await loginFormVisible(call))) return;
    await delay(200);
  }
}

async function previewLoadingVisible(call) {
  try {
    return !!cdpValue(await call('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const txt = (document.body?.innerText || '').toLowerCase();
        return /\\b(restoring admin session|checking saved operator access|loading|verifying|checking)\\b/.test(txt)
          && !/\\b(openhand admin\\s+operations|production operations|admin control plane|users online|nodes online)\\b/.test(txt);
      })()`,
    }));
  } catch {
    return false;
  }
}

async function waitForPreviewSettle(call) {
  const until = Date.now() + SHOT_LOAD_WAIT_MS;
  while (Date.now() < until) {
    if (!(await previewLoadingVisible(call))) return;
    await delay(200);
  }
}

async function evalJson(call, expression) {
  const r = await call('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression });
  return cdpValue(r);
}

async function pageProbe(call) {
  return await evalJson(call, `(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const text = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').replace(/\\s+/g, ' ').trim();
    const bodyText = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
    const buttons = [...document.querySelectorAll('button,a,[role="button"],[role="tab"],input[type="button"],input[type="submit"]')]
      .filter(visible)
      .slice(0, 80)
      .map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        return {
          text: text(el).slice(0, 120),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
          pointerEvents: cs.pointerEvents,
          covered: !!top && top !== el && !el.contains(top),
          rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        };
      });
    const scrollables = [...document.querySelectorAll('body,main,section,aside,div')]
      .filter(visible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
        return {
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || '').slice(0, 120),
          role: el.getAttribute('role') || '',
          text: text(el).slice(0, 80),
          maxScroll,
          overflowY: cs.overflowY,
          rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        };
      })
      .filter((x) => x.maxScroll > 24)
      .sort((a, b) => b.maxScroll - a.maxScroll)
      .slice(0, 12);
    return {
      url: location.href,
      title: document.title,
      authWall: /\\b(log in|login|sign in|access code|passcode|password|required)\\b/i.test(bodyText) && !/\\b(openhand admin|operations queue|users|devices|audit|invites)\\b/i.test(bodyText),
      bodySample: bodyText.slice(0, 800),
      viewport: { w: innerWidth, h: innerHeight, scrollY: Math.round(scrollY), docScroll: Math.max(0, document.documentElement.scrollHeight - innerHeight) },
      buttons,
      scrollables,
    };
  })()`);
}

async function clickSurface(call, surface) {
  const label = String(surface || '').trim();
  if (!label) return { clicked: false, reason: 'empty-label' };
  return await evalJson(call, `(${async (label) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const wanted = norm(label);
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const text = (el) => norm(el.innerText || el.value || el.getAttribute('aria-label') || el.title || '');
    const candidates = [...document.querySelectorAll('button,a,[role="button"],[role="tab"],[role="menuitem"],summary')]
      .filter(visible)
      .map((el) => ({ el, t: text(el) }))
      .filter((x) => x.t === wanted || x.t.includes(wanted) || wanted.includes(x.t))
      .sort((a, b) => (a.t === wanted ? -1 : 0) - (b.t === wanted ? -1 : 0));
    const hit = candidates[0];
    if (!hit) return { clicked: false, reason: 'surface-not-found', label };
    const el = hit.el;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { clicked: false, reason: 'surface-disabled', label, text: hit.t };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    el.click();
    return { clicked: true, label, text: hit.t, tag: el.tagName.toLowerCase() };
  }})(${JSON.stringify(label)})`);
}

async function interactionProbe(call, labels = []) {
  return await evalJson(call, `(${(labels) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const text = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim();
    const els = [...document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]')].filter(visible);
    return labels.map((label) => {
      const wanted = norm(label);
      const hits = els
        .map((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const top = document.elementFromPoint(cx, cy);
          const t = text(el);
          return {
            label,
            text: t,
            tag: el.tagName.toLowerCase(),
            disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
            ariaDisabled: el.getAttribute('aria-disabled') || '',
            pointerEvents: cs.pointerEvents,
            covered: !!top && top !== el && !el.contains(top),
            visible: true,
            rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          };
        })
        .filter((x) => norm(x.text) === wanted || norm(x.text).includes(wanted) || wanted.includes(norm(x.text)))
        .slice(0, 5);
      return { label, found: hits.length > 0, candidates: hits };
    });
  }})(${JSON.stringify(labels)})`);
}

async function scrollProbe(call) {
  const before = await evalJson(call, `(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const candidates = [...document.querySelectorAll('main,section,aside,div')]
      .filter(visible)
      .map((el, i) => {
        const r = el.getBoundingClientRect();
        return { i, maxScroll: Math.max(0, el.scrollHeight - el.clientHeight), x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, r.height - 8), area: r.width * r.height, right: r.left > innerWidth * 0.42, cls: String(el.className || '').slice(0, 100), text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80) };
      })
      .filter((x) => x.maxScroll > 24)
      .sort((a, b) => (Number(b.right) - Number(a.right)) || b.maxScroll - a.maxScroll || b.area - a.area);
    const target = candidates[0] || null;
    window.__aiosAuditScrollTarget = target ? target.i : -1;
    return { pageY: Math.round(scrollY), target, candidates: candidates.slice(0, 8) };
  })()`);
  if (!before?.target) return { ok: false, reason: 'no-scrollable-panel', before };
  try {
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: before.target.x, y: before.target.y, deltaY: 420, deltaX: 0 });
  } catch {}
  await delay(250);
  const after = await evalJson(call, `(() => {
    const els = [...document.querySelectorAll('main,section,aside,div')];
    const target = els[window.__aiosAuditScrollTarget] || null;
    return {
      pageY: Math.round(scrollY),
      targetScrollTop: target ? Math.round(target.scrollTop) : null,
      targetMaxScroll: target ? Math.max(0, target.scrollHeight - target.clientHeight) : null,
    };
  })()`);
  return {
    ok: true,
    target: before.target,
    pageScrollDelta: Math.round((after?.pageY ?? 0) - (before.pageY ?? 0)),
    targetScrollTop: after?.targetScrollTop ?? null,
    targetMaxScroll: after?.targetMaxScroll ?? null,
    bodyMoved: Math.abs((after?.pageY ?? 0) - (before.pageY ?? 0)) > 16,
  };
}

async function runProductAudit(call, spec) {
  const cfg = normalizeProductAuditSpec(spec);
  if (!cfg) return null;
  const audit = {
    kind: 'product_audit',
    spec: cfg,
    pages: [],
    screenshots: [],
  };
  const main = await pageProbe(call);
  audit.initial = main;
  if (main?.authWall) return audit;
  const surfaces = cfg.surfaces.slice(0, 6);
  for (const surface of surfaces) {
    const nav = await clickSurface(call, surface);
    await delay(700);
    await waitForPreviewSettle(call);
    const probe = await pageProbe(call);
    const page = {
      surface,
      nav,
      probe,
      scroll: cfg.checkScroll ? await scrollProbe(call) : null,
      interactions: cfg.interactions.length ? await interactionProbe(call, cfg.interactions) : [],
    };
    try {
      const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      audit.screenshots.push({ label: `audit ${surface}`, data: shot.data });
    } catch {}
    audit.pages.push(page);
  }
  if (!surfaces.length && cfg.interactions.length) {
    audit.pages.push({
      surface: 'current',
      nav: { clicked: false, reason: 'current-page' },
      probe: main,
      scroll: cfg.checkScroll ? await scrollProbe(call) : null,
      interactions: await interactionProbe(call, cfg.interactions),
    });
  }
  return audit;
}

async function cdpCapture(port, url, auth = null, opts = {}) {
  if (typeof WebSocket === 'undefined') throw new Error('global WebSocket unavailable (need Node >= 22)');
  const wsUrl = await cdpPageWs(port);
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  let loaded = false;
  const pending = new Map();
  const call = (method, params) =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  ws.addEventListener('message', (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message || 'cdp error')) : p.res(m.result);
    } else if (m.method === 'Page.loadEventFired') loaded = true;
  });
  try {
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('cdp websocket error')), { once: true });
    });
    await call('Page.enable');
    await call('Runtime.enable');
    const openHandAdmin = (() => {
      try {
        const u = new URL(url);
        return u.pathname.startsWith('/admin') && /(^|\.)openhand\.ai$/i.test(u.hostname);
      } catch {
        return false;
      }
    })();
    // OpenHand Admin keeps its passcode in localStorage and sends it as x-compx-pass on API calls.
    // Seed it before app JS runs; the Chrome profile is per-session evidence scratch space.
    if (auth?.passcode && openHandAdmin) {
      await call('Page.addScriptToEvaluateOnNewDocument', {
        source: `try {
          localStorage.setItem('openhand_admin_pass', ${JSON.stringify(auth.passcode)});
          localStorage.setItem('openhand_mvp_pass', ${JSON.stringify(auth.passcode)});
        } catch {}`,
      });
    }
    // Passcode-gated preview: support HTTP Basic/reverse-proxy gates, OpenHand Admin, and simple email/access-code forms.
    if (auth && auth.passcode) {
      try {
        await call('Network.enable');
        const headers = {};
        const token = Buffer.from(`${auth.username || ''}:${auth.passcode}`).toString('base64');
        headers.Authorization = `Basic ${token}`;
        if (openHandAdmin) headers['x-compx-pass'] = auth.passcode;
        await call('Network.setExtraHTTPHeaders', { headers });
      } catch { /* not a basic-auth gate — navigate anyway */ }
    }
    await call('Page.navigate', { url });
    await waitForLoad(() => loaded);
    await delay(SHOT_SETTLE_MS);
    await waitForPreviewSettle(call);
    if (auth?.passcode && await loginFormVisible(call)) {
      loaded = false;
      if (await fillPasscodeForm(call, auth)) {
        await waitForLoginResult(call, () => loaded);
        await delay(SHOT_SETTLE_MS);
        await waitForPreviewSettle(call);
      }
    }
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const productAudit = opts.product_audit ? await runProductAudit(call, opts.product_audit).catch((e) => ({ kind: 'product_audit_error', error: String(e.message || e).slice(0, 200) })) : null;
    return { screenshot: shot.data, productAudit };
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

async function cdpScreenshot(port, url, auth = null) {
  return (await cdpCapture(port, url, auth)).screenshot;
}

export async function capturePreview(session_id, url, auth = null, opts = {}) {
  const dir = join(SHOT_DIR, session_id);
  await mkdir(dir, { recursive: true });
  const file = `${Date.now()}.png`;
  const out = join(dir, file);
  const profileDir = join(dir, 'profile');
  const port = await freePort();
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profileDir}`,
      '--password-store=basic',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-default-apps',
      '--mute-audio',
      `--remote-debugging-port=${port}`,
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  child.on('error', () => {});
  const kill = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
  }, SHOT_TIMEOUT_MS + 2000);
  let shotTimer = null;
  let productAudit = null;
  try {
    const timeout = new Promise((_, rej) => {
      shotTimer = setTimeout(() => rej(new Error('screenshot timed out')), SHOT_TIMEOUT_MS);
    });
    const captured = await Promise.race([
      cdpCapture(port, url, auth, opts),
      timeout,
    ]);
    await writeFile(out, Buffer.from(captured.screenshot, 'base64'));
    if (captured.productAudit?.screenshots?.length) {
      captured.productAudit.savedScreenshots = [];
      let i = 0;
      for (const s of captured.productAudit.screenshots.slice(0, 6)) {
        i += 1;
        const auditFile = `${Date.now()}-audit-${i}.png`;
        const auditOut = join(dir, auditFile);
        await writeFile(auditOut, Buffer.from(s.data, 'base64'));
        captured.productAudit.savedScreenshots.push({ label: s.label, file: auditFile, rel: join('supervisor', session_id, auditFile), abs: auditOut });
      }
      delete captured.productAudit.screenshots;
    }
    productAudit = captured.productAudit || null;
  } finally {
    if (shotTimer) clearTimeout(shotTimer);
    clearTimeout(kill);
    try {
      child.kill('SIGKILL');
    } catch {}
  }
  await stat(out);
  await pruneShots(dir);
  return { file, rel: join('supervisor', session_id, file), abs: out, productAudit };
}

function pngDataUrl(buf) {
  return 'data:image/png;base64,' + buf.toString('base64');
}

function previewTargets({ preview_url, preview_auth = null, preview_profiles = [] } = {}) {
  const targets = [];
  for (const p of activePreviewProfiles({ preview_profiles })) {
    targets.push({
      label: p.label || 'Preview',
      url: p.url,
      auth: p.passcode_gated && p.passcode ? { username: p.username || '', passcode: p.passcode } : null,
    });
  }
  if (!targets.length && preview_url) targets.push({ label: 'Preview', url: preview_url, auth: preview_auth });
  return targets;
}

// Capture preview screenshot(s). Returns [{kind, label, dataUrl?, rel?}]; one entry per configured URL.
export async function gatherImages(session, { preview_url, preview_auth = null, preview_profiles = [], product_audit = null } = {}) {
  const images = [];
  for (const t of previewTargets({ preview_url, preview_auth, preview_profiles })) {
    try {
      const shot = await capturePreview(session.id, t.url, t.auth, { product_audit });
      const buf = await readFile(shot.abs);
      images.push({ kind: 'preview', label: `preview ${t.label}: ${t.url}`, dataUrl: pngDataUrl(buf), rel: shot.rel });
      if (shot.productAudit) {
        images.push({ kind: 'product-audit', label: `product audit ${t.label}: ${t.url}`, audit: shot.productAudit });
        for (const s of shot.productAudit.savedScreenshots || []) {
          const sbuf = await readFile(s.abs);
          images.push({ kind: 'preview-audit', label: `${s.label} ${t.label}: ${t.url}`, dataUrl: pngDataUrl(sbuf), rel: s.rel });
        }
      }
    } catch (e) {
      images.push({ kind: 'preview-error', label: `preview ${t.label} failed: ${String(e.message || e).slice(0, 120)}` });
    }
  }
  return images;
}

// Structured, read-only session context: project, session row fields, git evidence, recent
// messages, terminal tail. `includeDiff` adds the full unified diff (heavier).
export async function sessionContext(session, { terminalMax = 16000, includeDiff = false, baseRef = null } = {}) {
  const project = session.project_id ? getProject(session.project_id) : null;
  const cwd = project?.path || null;
  const [git, terminal, graph] = await Promise.all([
    cwd ? gitEvidence(cwd, { baseRef }).catch(() => null) : null,
    terminalTail(session.id, terminalMax),
    project ? projectGraphBrief(project).catch(() => null) : null,
  ]);
  const allMsgs = messagesFor(session.id, 200);
  const original = allMsgs.find((m) => m.direction === 'in'); // the user's first/original request — the anchor for "what they want"
  const recent = allMsgs.slice(-60).map((m) => ({ dir: m.direction, src: m.source, text: tailStr(m.text, 1500) }));
  const gitView = git
    ? {
        status: git.status,
        stat: git.stat,
        commits_since_baseline: git.commits || '',
        committed_stat: git.committed_stat || '',
        touched_test_files: git.touched_test_files,
        // multi-repo workspace: the project path holds several repos; evidence is aggregated across the active
        // ones, each section prefixed "### <repo>/". Surfaced so the reviewer reads it as one workspace.
        ...(git.multi_repo ? { multi_repo: git.multi_repo } : {}),
        ...(includeDiff ? { diff: git.diff, committed_diff: git.committed_diff || '' } : {}),
      }
    : null;
  return {
    project: project ? { id: project.id, name: project.name, path: project.path } : null,
    session: {
      id: session.id,
      tool: session.tool,
      model: session.model,
      status: session.status,
      category: session.category,
      summary: session.summary,
      title: session.title,
      autonomy: session.autonomy,
      started_at: session.started_at,
      last_activity: session.last_activity,
    },
    git: gitView,
    project_graph: graph,
    original_request: original ? tailStr(original.text, 2500) : null,
    recent_messages: recent,
    terminal_tail: terminal,
  };
}
