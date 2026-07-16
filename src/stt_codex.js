import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { randomBytes } from 'node:crypto';

// Codex subscription STT: transcribe via the user's OWN ChatGPT/Codex login against the private
// Codex Desktop endpoint. Unofficial + reverse-engineered (see docs/specs/subscription-stt-plan.md) —
// so every failure is TYPED and the caller falls back to Spark. We read ~/.codex/auth.json FRESH each
// attempt (the Codex CLI owns refresh; codex is refreshable:false in our auth pkg, so its cached
// getAccessToken would rot) and derive token+account from ONE snapshot so a mid-flight CLI rotation
// can't pair token A with account B. The token is never cached, copied, logged, or put in argv/env.

const ENDPOINT = { host: 'chatgpt.com', path: '/backend-api/transcribe' };
const AUTH_FILE = process.env.AIOS_CODEX_AUTH_FILE || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
const CLOCK_SKEW_MS = 60_000;

// Typed error so the route can classify (fall-through vs surface). `kind` ∈
// no_file | bad_json | no_token | expired | no_account | http | timeout | network.
export class CodexSttError extends Error {
  constructor(kind, message, { status } = {}) { super(message); this.name = 'CodexSttError'; this.kind = kind; this.status = status; }
}

function b64urlJson(seg) {
  const s = seg.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(s + '='.repeat((4 - (s.length % 4)) % 4), 'base64').toString('utf8'));
}

// Read + validate ONE snapshot of auth.json. Returns { token, account, exp }. Throws CodexSttError.
export async function codexDictationAuth() {
  let raw;
  try { raw = await readFile(AUTH_FILE, 'utf8'); }
  catch (e) { throw new CodexSttError(e.code === 'EACCES' ? 'no_file' : 'no_file', `codex auth unreadable: ${e.code || e.message}`); }
  if (raw.length > 256 * 1024) throw new CodexSttError('bad_json', 'codex auth file implausibly large');
  let cred;
  try { cred = JSON.parse(raw); } catch { throw new CodexSttError('bad_json', 'codex auth is not valid JSON (mid-write?)'); }
  const token = cred?.tokens?.access_token;
  if (!token || typeof token !== 'string') throw new CodexSttError('no_token', 'codex auth has no access_token');
  // exp from the access-token JWT (best-effort); skew-guarded.
  let exp = null;
  try { exp = b64urlJson(token.split('.')[1]).exp; } catch {}
  if (exp && Date.now() > exp * 1000 + CLOCK_SKEW_MS) throw new CodexSttError('expired', 'codex access_token expired — open Codex to refresh');
  // account_id: prefer the file field (what AIOS/CLI write, verified present) over the unverified JWT claim.
  let account = cred?.tokens?.account_id || null;
  if (!account) {
    try { const a = b64urlJson(token.split('.')[1])['https://api.openai.com/auth'] || {}; account = a.chatgpt_account_id || a.account_id || null; } catch {}
  }
  if (!account) throw new CodexSttError('no_account', 'codex auth has no account_id');
  return { token, account, exp };
}

// Cheap availability probe for source resolution (does NOT prove the endpoint works — just that we
// have a usable, unexpired local credential). Never throws.
export async function codexSttAvailable() {
  try { await codexDictationAuth(); return true; } catch { return false; }
}

function multipartWav(wav) {
  const boundary = '----aios-codex-' + randomBytes(9).toString('hex');
  const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([pre, wav, post]), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Transcribe a 16kHz mono s16 WAV buffer. Returns { text }. Throws CodexSttError on any failure so the
// route can decide fall-through. `signal` cancels on client disconnect; bounded upstream read.
export function transcribeCodex(wav, { signal, timeoutMs = 25_000 } = {}) {
  return new Promise((resolve, reject) => {
    codexDictationAuth().then((auth) => {
      const { body, contentType } = multipartWav(wav);
      const req = https.request(
        {
          host: ENDPOINT.host, port: 443, path: ENDPOINT.path, method: 'POST', servername: ENDPOINT.host, timeout: timeoutMs,
          headers: {
            Authorization: `Bearer ${auth.token}`,
            'ChatGPT-Account-Id': auth.account,
            originator: 'Codex Desktop',
            'User-Agent': 'Codex Desktop/0.0.0 (Macintosh; Intel Mac OS X; arm64)',
            'content-type': contentType,
            'content-length': body.length,
            accept: 'application/json',
          },
        },
        (r) => {
          const chunks = []; let n = 0; let capped = false;
          r.on('data', (c) => { n += c.length; if (n <= 512 * 1024) chunks.push(c); else capped = true; });
          r.on('end', () => {
            const status = r.statusCode || 0;
            const text = Buffer.concat(chunks).toString('utf8');
            if (status === 401 || status === 403) return reject(new CodexSttError('http', `codex ${status} (reauth)`, { status }));
            if (status === 429) return reject(new CodexSttError('http', 'codex 429 rate-limited', { status }));
            if (status >= 400 || capped) return reject(new CodexSttError('http', `codex ${status}`, { status }));
            let out = '';
            try { out = JSON.parse(text)?.text || ''; } catch { return reject(new CodexSttError('http', 'codex returned non-JSON')); }
            out = String(out).trim();
            if (!out) return reject(new CodexSttError('http', 'codex returned empty transcript'));
            resolve({ text: out });
          });
        }
      );
      req.on('error', (e) => reject(new CodexSttError('network', `codex request failed: ${e.code || e.message}`)));
      req.on('timeout', () => req.destroy(new CodexSttError('timeout', 'codex request timed out')));
      if (signal) {
        if (signal.aborted) { req.destroy(); return reject(new CodexSttError('network', 'aborted')); }
        signal.addEventListener('abort', () => req.destroy(new CodexSttError('network', 'aborted')), { once: true });
      }
      req.write(body); req.end();
    }).catch(reject);
  });
}
