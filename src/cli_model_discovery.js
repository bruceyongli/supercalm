// Subscription model discovery. The CLIs are authoritative for models the signed-in account can
// actually select, so the catalog asks them before probing API providers or the local proxy fleet.
// Codex exposes a supported app-server model/list method (actively refreshed); its on-disk cache is
// an offline fallback. Antigravity exposes `agy models`. Claude has no list command, but recent CLI
// builds persist a gateway model cache; only a non-AIOS gateway cache is accepted to avoid feeding
// our own catalog back into itself.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loggedIn } from './auth/store.js';
import { listAgyModels } from './auth/agy_cli.js';

const TIMEOUT_MS = Number(process.env.AIOS_CLI_MODEL_TIMEOUT_MS || 15_000);

function prettyModelId(id) {
  const parts = String(id).split('-').filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (/^\d+$/.test(part) && out.length && /^\d[\d.]*$/.test(out[out.length - 1])) out[out.length - 1] += '.' + part;
    else out.push(/^\d/.test(part) ? part : part[0].toUpperCase() + part.slice(1));
  }
  return out.join(' ');
}

function displayLabel(value, id) {
  return String(value || prettyModelId(id)).replace(/(?<=[A-Za-z0-9])-(?=[A-Za-z])/g, ' ');
}

function codexBin() {
  if (process.env.AIOS_CODEX_BIN) return process.env.AIOS_CODEX_BIN;
  if (existsSync('/opt/homebrew/bin/codex')) return '/opt/homebrew/bin/codex';
  return 'codex';
}

function cliEnv() {
  return {
    ...process.env,
    PATH: `/opt/homebrew/bin:${join(homedir(), '.local', 'bin')}:${process.env.PATH || ''}`,
  };
}

export function parseCodexModels(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((m) => m && (m.id || m.slug || m.model) && m.hidden !== true && m.visibility !== 'hide')
    .sort((a, b) => Number(a.priority ?? 999) - Number(b.priority ?? 999))
    .map((m, index) => {
      const id = String(m.model || m.slug || m.id);
      const speedTiers = [
        ...(m.serviceTiers || m.service_tiers || []),
        ...(m.additionalSpeedTiers || m.additional_speed_tiers || []),
      ];
      const modalities = m.inputModalities || m.input_modalities || [];
      return {
        id,
        label: displayLabel(m.displayName || m.display_name, id),
        recommended: !!m.isDefault || !!m.is_default || Number(m.priority) <= 3 || index < 3,
        kind: 'chat',
        supportsFast: speedTiers.some((tier) => /^(?:fast|priority)$/i.test(String(tier?.id || tier?.name || tier))),
        vision: modalities.includes('image'),
        source: 'cli',
      };
    });
}

export function parseCodexModelsCache(payload) {
  return parseCodexModels(payload?.models || payload?.data || []);
}

export function parseClaudeModelsCache(payload) {
  const base = String(payload?.baseUrl || payload?.base_url || '');
  if (/\/api\/cli-proxy(?:\/|$)|127\.0\.0\.1:8793|localhost:8793/i.test(base)) return [];
  return (Array.isArray(payload?.models) ? payload.models : [])
    .filter((m) => m && (m.id || m.model))
    .map((m, index) => {
      const id = String(m.id || m.model);
      return {
        id,
        label: m.displayName || m.display_name || m.label || prettyModelId(id),
        recommended: !!m.recommended || index < 3,
        kind: 'chat',
        vision: m.vision !== false,
        source: 'cli',
      };
    });
}

function queryCodexAppServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin(), ['app-server'], {
      cwd: process.cwd(),
      env: cliEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch {}
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Codex model list timed out')), TIMEOUT_MS);
    child.on('error', (error) => finish(error));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      for (;;) {
        const end = stdout.indexOf('\n');
        if (end < 0) break;
        const line = stdout.slice(0, end).trim();
        stdout = stdout.slice(end + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(new Error(message.error.message || 'Codex initialize failed'));
          child.stdin.write(JSON.stringify({ id: 2, method: 'model/list', params: { limit: 100, includeHidden: false } }) + '\n');
        } else if (message.id === 2) {
          if (message.error) return finish(new Error(message.error.message || 'Codex model list failed'));
          return finish(null, parseCodexModels(message.result?.data));
        }
      }
    });
    child.on('close', (code) => {
      if (!settled) finish(new Error(`Codex app-server exited with ${code}: ${stderr.replace(/\s+/g, ' ').trim().slice(0, 160)}`));
    });
    child.stdin.write(JSON.stringify({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'aios-model-catalog', title: 'AIOS model catalog', version: '1' } },
    }) + '\n');
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function discoverCodex() {
  if (!(await loggedIn('codex').catch(() => false))) return { models: [], status: 'not-authenticated' };
  const cachePath = process.env.AIOS_CODEX_MODELS_CACHE || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json');
  let cached = [];
  try { cached = parseCodexModelsCache(await readJson(cachePath)); } catch {}
  try {
    const models = await queryCodexAppServer();
    if (models.length) {
      const byId = new Map(cached.map((model) => [model.id, model]));
      return {
        models: models.map((model) => {
          const cache = byId.get(model.id);
          return cache ? {
            ...model,
            supportsFast: model.supportsFast || cache.supportsFast,
            vision: model.vision || cache.vision,
          } : model;
        }),
        status: 'cli-live',
      };
    }
  } catch {}
  return { models: cached, status: cached.length ? 'cli-cache' : 'unavailable' };
}

async function discoverClaude() {
  if (!(await loggedIn('claude').catch(() => false))) return { models: [], status: 'not-authenticated' };
  const cachePath = process.env.AIOS_CLAUDE_MODELS_CACHE || join(homedir(), '.claude', 'cache', 'gateway-models.json');
  try {
    const models = parseClaudeModelsCache(await readJson(cachePath));
    return { models, status: models.length ? 'cli-cache' : 'aios-cache-skipped' };
  } catch (error) {
    return { models: [], status: 'unavailable', error: String(error.message || error).slice(0, 160) };
  }
}

async function discoverAntigravity() {
  try {
    const ids = await listAgyModels();
    return {
      models: ids.map((id, index) => ({
        id,
        label: prettyModelId(id),
        recommended: index < 3,
        kind: 'chat',
        source: 'cli',
      })),
      status: ids.length ? 'cli-live' : 'empty',
    };
  } catch (error) {
    return { models: [], status: 'not-authenticated', error: String(error.message || error).replace(/\s+/g, ' ').slice(0, 160) };
  }
}

export async function discoverCliModels() {
  const [codex, claude, antigravity] = await Promise.all([
    discoverCodex(),
    discoverClaude(),
    discoverAntigravity(),
  ]);
  const providers = { codex: codex.models, claude: claude.models, antigravity: antigravity.models };
  const sources = Object.fromEntries(Object.entries({ codex, claude, antigravity }).map(([id, result]) => [
    id,
    { status: result.status, modelCount: result.models.length, ...(result.error ? { error: result.error } : {}) },
  ]));
  return { providers, sources, modelCount: Object.values(providers).reduce((n, models) => n + models.length, 0) };
}
