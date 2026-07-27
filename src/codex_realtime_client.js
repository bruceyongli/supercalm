import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

const DEFAULT_TIMEOUT_MS = 15_000;

function rpcError(error) {
  const message = error?.message || error?.data?.message || String(error || 'Codex App Server request failed');
  const out = new Error(message);
  out.code = error?.code;
  out.data = error?.data;
  return out;
}

/**
 * Minimal JSONL client for the experimental Codex App Server realtime methods.
 *
 * The protocol deliberately omits the JSON-RPC `jsonrpc` header on the wire.
 * Keeping this adapter separate from the HTTP routes makes the unstable surface
 * easy to replace when the installed Codex schema changes.
 */
export class CodexAppServerClient extends EventEmitter {
  constructor({
    codexBin = 'codex',
    cwd = process.cwd(),
    env = process.env,
    spawnImpl = nodeSpawn,
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    super();
    this.codexBin = codexBin;
    this.cwd = cwd;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.nextId = 0;
    this.pending = new Map();
    this.stderr = '';
    this.closed = false;
  }

  async initialize() {
    if (this.child) return;
    this.child = this.spawnImpl(
      this.codexBin,
      ['app-server', '--enable', 'realtime_conversation', '--listen', 'stdio://'],
      { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child.stderr?.on('data', (chunk) => {
      // Keep a small diagnostic tail, but never print it: upstream errors can
      // include request context that should not enter production logs.
      this.stderr = (this.stderr + String(chunk)).slice(-4000);
    });
    this.child.stdin?.on('error', (error) => this.#fail(error));
    this.child.on('error', (error) => this.#fail(error));
    this.child.on('exit', (code, signal) => {
      if (!this.closed) this.#fail(new Error(`Codex App Server exited (${code ?? signal ?? 'unknown'})`));
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => this.#onLine(line));

    // Codex expects initialize immediately followed by the initialized
    // notification. Do not await the request before sending the notification.
    const ready = this.request('initialize', {
      clientInfo: {
        name: 'aios_realtime_poc',
        title: 'AIOS Realtime PoC',
        version: '0.1.0',
      },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
    await ready;
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error('Codex App Server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params = {}) {
    if (!this.child?.stdin?.writable) throw new Error('Codex App Server is not running');
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  waitFor(method, { predicate = () => true, timeoutMs = this.requestTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const onMessage = (params) => {
        if (!predicate(params)) return;
        cleanup();
        resolve(params);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${method} notification timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        this.off(method, onMessage);
      };
      this.on(method, onMessage);
    });
  }

  async account() {
    return this.request('account/read', { refreshToken: false });
  }

  async voices() {
    const result = await this.request('thread/realtime/listVoices', {});
    return result.voices;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.lines?.close();
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('Codex App Server client closed'));
    }
    this.pending.clear();
    if (this.child?.stdin?.writable) this.child.stdin.end();
    if (this.child && this.child.exitCode == null) this.child.kill('SIGTERM');
    this.child = null;
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit('protocol/error', { message: 'Codex App Server emitted invalid JSON' });
      return;
    }
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(rpcError(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      // `error` is a normal App Server notification method, but Node reserves
      // EventEmitter's literal "error" event and throws when it has no listener.
      // Keep server errors observable without letting one crash the AIOS host.
      const event = message.method === 'error' ? 'server/error' : message.method;
      this.emit(event, message.params || {});
    }
  }

  #fail(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.emit('transport/error', error);
  }
}

export function publicRealtimeError(error) {
  const message = String(error?.message || error || '');
  if (/requires API key auth/i.test(message)) {
    return {
      status: 424,
      code: 'api-key-required',
      message: 'Codex realtime requires API-key authentication. Add OPENAI_API_KEY to the existing gitignored data/aios.env and restart AIOS.',
    };
  }
  if (/not found|ENOENT/i.test(message)) {
    return { status: 503, code: 'codex-not-found', message: 'The Codex CLI was not found on this host.' };
  }
  if (/timed out/i.test(message)) {
    return { status: 504, code: 'codex-realtime-timeout', message: 'Codex realtime did not answer before the timeout.' };
  }
  if (/unauthorized|incorrect api key|invalid api key/i.test(message)) {
    return { status: 401, code: 'api-key-rejected', message: 'OpenAI rejected the configured API key.' };
  }
  if (/quota|usage limit|rate limit/i.test(message)) {
    return { status: 429, code: 'realtime-limit', message: 'The OpenAI realtime request reached an account limit.' };
  }
  // Do not echo arbitrary upstream text into the browser; it can contain
  // provider request context or host details.
  return { status: 502, code: 'codex-realtime-failed', message: 'Codex realtime could not start.' };
}
