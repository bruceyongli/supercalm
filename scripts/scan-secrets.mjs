#!/usr/bin/env node
// Supercalm secret / private-data scanner — the guard that stops sensitive data from ever reaching a
// public remote. Zero dependencies (Node built-ins only), so it runs in a git hook and in CI with no
// install step. Wired as pre-commit + pre-push (bin/install-hooks) AND a CI job (.github/workflows).
//
//   node scripts/scan-secrets.mjs            # scan every tracked file (default; used by hooks + CI)
//   node scripts/scan-secrets.mjs <file...>  # scan specific files
//
// Exit 0 = clean, exit 1 = a potential secret/PII was found (printed, redacted). A genuine false
// positive can be waived with an inline "secret-scan: allow" comment on that exact line.

import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

// [label, regex]. Tuned for what actually leaks from a self-hosted setup like this one: embedded OAuth
// app credentials, cloud/API tokens, private keys, and the operator's own network identifiers.
const RULES = [
  ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/],
  ['Google OAuth client secret', /GOCSPX-[A-Za-z0-9_-]{20,}/],
  ['Google OAuth client id', /[0-9]{10,}-[a-z0-9]{16,}\.apps\.googleusercontent\.com/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/],
  ['OpenAI/Anthropic key', /sk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{24,}/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['Tailscale/CGNAT IP', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
  ['MAC address', /\b(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b/],
  ['Personal email', /\b[A-Za-z0-9._%+-]+@(?:gmail|outlook|hotmail|yahoo|ymail|icloud|proton(?:mail)?|qq|163)\.[a-z]{2,}\b/i],
  ['Hardcoded assigned secret', /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["'][^"'\s]{16,}["']/i],
];

// Files that legitimately contain secret-shaped text (this scanner's own rules; lock hashes; vendored libs).
const SKIP_PATH = [/^scripts\/scan-secrets\.mjs$/, /^scripts\/hooks\//, /^\.gitleaks/, /^package-lock\.json$/, /^web\/vendor\//, /^docs\/CONFIGURATION\.md$/];
const SKIP_EXT = /\.(png|jpe?g|gif|svg|ico|woff2?|ttf|eot|webmanifest|gz|zip|mp3|wav|pdf|lock)$/i;
// Per-line waiver: an explicit allow comment, or an unmistakable placeholder / documentation example.
const ALLOW_LINE = /secret-scan:\s*allow|example\.(?:com|org)|your-[a-z]|<[A-Za-z0-9_ .-]+>|placeholder|REDACTED|xxxx|100\.x|192\.168\.x|10\.x\b|\baa:bb:cc\b|noreply/i;

function tracked() {
  try { return execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean); }
  catch { return []; }
}

const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const files = argv.length ? argv : tracked();

function redact(s) {
  return s.trim().slice(0, 120)
    .replace(/(GOCSPX-|AIza|gh[pousr]_|github_pat_|sk-(?:ant-|proj-|live-)?|AKIA)[A-Za-z0-9_-]+/g, '$1***')
    .replace(/\b(\d{1,3})(\.\d{1,3}){3}\b/g, '$1.**.**.**')
    .replace(/\b([0-9a-fA-F]{2})(:[0-9a-fA-F]{2}){5}\b/g, '$1:**:**:**:**:**')
    .replace(/@([a-z]+)\.[a-z.]+/gi, '@$1.***');
}

const hits = [];
for (const f of files) {
  if (SKIP_PATH.some((r) => r.test(f)) || SKIP_EXT.test(f)) continue;
  let text;
  try { if (statSync(f).size > 2_000_000) continue; text = readFileSync(f, 'utf8'); } catch { continue; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (ALLOW_LINE.test(lines[i])) continue;
    for (const [name, rx] of RULES) {
      if (rx.test(lines[i])) hits.push({ loc: `${f}:${i + 1}`, name, snippet: redact(lines[i]) });
    }
  }
}

if (hits.length) {
  console.error(`\n⛔  Supercalm secret-scan BLOCKED this ${process.env.SUPERCALM_SCAN_PHASE || 'change'} — ${hits.length} potential secret(s) / private data:\n`);
  for (const h of hits) console.error(`   ${h.loc}  [${h.name}]\n      ${h.snippet}`);
  console.error(`\n   Fix: move the value into an env var read from data/aios.env (gitignored), not source.`);
  console.error(`   False positive? Add an inline "secret-scan: allow" comment on that line.`);
  console.error(`   Docs: docs/CONFIGURATION.md · SECURITY.md\n`);
  process.exit(1);
}
console.log(`✓ secret-scan clean (${files.length} files)`);
