// Minimal localhost Anthropic passthrough for Supercalm-managed claude auth. claude sessions point
// ANTHROPIC_BASE_URL here; it injects the OAuth bearer (centrally refreshed via store.js) + the
// oauth beta + the Claude Code system marker, forwards to api.anthropic.com, and pipes the
// response (incl. SSE) straight back. ONE central refresher → many sessions never race the
// rotating single-use refresh token. No model mapping (claude sends real IDs). Independent
// re-impl of ~/proxy/claude/src/anthropic.js (off-limits), minus model-aliasing/OpenAI-compat.

import http from 'node:http';
import { Readable } from 'node:stream';
import { getAccessToken, forceRefresh } from './store.js';
import { mergeAnthropicUsage, recordAnthropicShimUsage } from '../usage_collect.js';

const ANTHROPIC_API_BASE = process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com';
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01';
const ANTHROPIC_BETA = process.env.ANTHROPIC_BETA || 'oauth-2025-04-20';
const SYSTEM_MARKER = "You are Claude Code, Anthropic's official CLI for Claude.";
const SHIM_PORT = Number(process.env.AIOS_CLAUDE_SHIM_PORT || 8799);
const SHIM_HOST = '127.0.0.1';

function ensureClaudeCodeSystem(body) {
  if (!body || typeof body !== 'object') return body;
  const out = { ...body };
  const existing = out.system;
  if (Array.isArray(existing)) {
    const first = existing[0];
    if (first?.type === 'text' && typeof first.text === 'string' && first.text.startsWith(SYSTEM_MARKER)) return out;
    out.system = [{ type: 'text', text: SYSTEM_MARKER }, ...existing];
  } else if (typeof existing === 'string') {
    out.system = existing.startsWith(SYSTEM_MARKER) ? existing : [{ type: 'text', text: SYSTEM_MARKER }, { type: 'text', text: existing }];
  } else {
    out.system = [{ type: 'text', text: SYSTEM_MARKER }];
  }
  return out;
}

async function authHeaders() {
  const { accessToken } = await getAccessToken('claude');
  return {
    Authorization: `Bearer ${accessToken}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': ANTHROPIC_BETA,
    'User-Agent': 'claude-cli/2.1.0 aios-claude-shim/1.0',
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function forward(method, path, rawBody, signal) {
  const isMessages = /^\/v1\/messages(\/|\?|$)/.test(path);
  let outBody = rawBody;
  if (isMessages && rawBody && rawBody.length) {
    try {
      outBody = Buffer.from(JSON.stringify(ensureClaudeCodeSystem(JSON.parse(rawBody.toString('utf8')))));
    } catch {
      /* not JSON — forward as-is */
    }
  }
  let url = ANTHROPIC_API_BASE + path;
  if (isMessages && !/[?&]beta=/.test(path)) url += (path.includes('?') ? '&' : '?') + 'beta=true';
  const call = async () => {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(await authHeaders()) };
    return fetch(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : outBody, signal });
  };
  let res = await call();
  if (res.status === 401) {
    await forceRefresh('claude').catch(() => {});
    res = await call();
  }
  return res;
}

async function handle(req, res) {
  if (req.url === '/healthz' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, shim: 'aios-claude' }));
    return;
  }
  const ac = new AbortController();
  let clientGone = false;
  res.on('close', () => { if (!res.writableEnded) { clientGone = true; ac.abort(); } });
  try {
    const rawBody = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req);
    const upstream = await forward(req.method, req.url, rawBody, ac.signal);
    const headers = {};
    for (const [k, v] of upstream.headers) {
      if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) continue;
      headers[k] = v;
    }
    res.writeHead(upstream.status, headers);
    const tracker = usageTracker(rawBody, upstream, req.url);
    if (upstream.body) {
      const ns = Readable.fromWeb(upstream.body);
      ns.on('error', () => { try { res.destroy(); } catch {} });
      ns.on('data', (c) => tracker.chunk(c));
      ns.on('end', () => tracker.finish(upstream.status));
      ns.pipe(res);
    } else {
      tracker.finish(upstream.status);
      res.end();
    }
  } catch (e) {
    if (clientGone || ac.signal.aborted) { try { res.destroy(); } catch {} return; }
    const msg = String(e?.message || e);
    const status = /not logged in/.test(msg) ? 401 : 502;
    if (!res.headersSent) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'api_error', message: `aios-claude-shim: ${msg}` } }));
    } else {
      try { res.destroy(); } catch {}
    }
  }
}

function usageTracker(rawBody, upstream, path) {
  const ct = upstream.headers.get('content-type') || '';
  const isSse = ct.includes('text/event-stream');
  let usage = null;
  let text = '';
  let sseBuf = '';

  const note = (u) => {
    usage = mergeAnthropicUsage(usage, u);
  };
  const parseEvent = (block) => {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') return;
    try {
      const obj = JSON.parse(data);
      note(obj.usage || obj.message?.usage);
    } catch {}
  };

  return {
    chunk(c) {
      const s = Buffer.isBuffer(c) ? c.toString('utf8') : String(c);
      if (isSse) {
        sseBuf += s;
        const parts = sseBuf.split(/\r?\n\r?\n/);
        sseBuf = parts.pop() || '';
        for (const p of parts) parseEvent(p);
      } else if (text.length < 2 * 1024 * 1024) {
        text += s;
      }
    },
    finish(status) {
      if (isSse && sseBuf) parseEvent(sseBuf);
      if (!isSse && text) {
        try {
          note(JSON.parse(text).usage);
        } catch {}
      }
      try {
        recordAnthropicShimUsage({ requestBody: rawBody, responseHeaders: upstream.headers, usage, status, path });
      } catch (e) {
        console.error('[aios] claude shim usage record failed:', e.message);
      }
    },
  };
}

let server = null;
let starting = null;

export function ensureShim() {
  if (server) return Promise.resolve(baseUrl());
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    const s = http.createServer(handle);
    s.on('error', (e) => {
      starting = null;
      if (e.code === 'EADDRINUSE') { server = null; resolve(baseUrl()); }
      else reject(e);
    });
    s.listen(SHIM_PORT, SHIM_HOST, () => {
      server = s;
      starting = null;
      console.log(`[aios] claude shim listening on ${baseUrl()}`);
      resolve(baseUrl());
    });
  });
  return starting;
}

export function baseUrl() {
  return `http://${SHIM_HOST}:${SHIM_PORT}`;
}
export function shimRunning() {
  return !!server;
}
export function stopShim() {
  if (server) { server.close(); server = null; }
}
