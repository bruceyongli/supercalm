import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const CACHE_MS = Number(process.env.AIOS_AGY_AUTH_PROBE_CACHE_MS || 15000);
const TIMEOUT_MS = Number(process.env.AIOS_AGY_AUTH_PROBE_TIMEOUT_MS || 8000);

let cache = null;

function agyBin() {
  if (process.env.AIOS_AGY_BIN) return process.env.AIOS_AGY_BIN;
  const local = join(homedir(), '.local', 'bin', 'agy');
  if (existsSync(local)) return local;
  if (existsSync('/opt/homebrew/bin/agy')) return '/opt/homebrew/bin/agy';
  return 'agy';
}

function probeEnv() {
  return {
    ...process.env,
    PATH: `/opt/homebrew/bin:${join(homedir(), '.local', 'bin')}:${process.env.PATH || ''}`,
  };
}

function runAgyModels() {
  return new Promise((resolve, reject) => {
    const p = spawn(agyBin(), ['models'], {
      cwd: process.cwd(),
      env: probeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      p.kill('SIGKILL');
    }, TIMEOUT_MS);
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', (e) => {
      clearTimeout(timer);
      e.stdout = stdout;
      e.stderr = stderr;
      reject(e);
    });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const e = new Error(`agy models exited with ${signal || code}`);
      e.code = code;
      e.signal = signal;
      e.killed = killed;
      e.stdout = stdout;
      e.stderr = stderr;
      reject(e);
    });
  });
}

function normalizeError(e) {
  const out = `${e?.stdout || ''}${e?.stderr || ''}${e?.message || ''}`.replace(/\s+/g, ' ').trim();
  if (
    e?.code === 1 ||
    /please sign in|launch the cli without arguments to sign in|not logged into antigravity|not signed in/i.test(out)
  ) {
    return {
      loggedIn: false,
      message: 'Antigravity CLI is not signed in.',
      detail: out || null,
    };
  }
  return {
    loggedIn: false,
    message: 'Unable to verify Antigravity CLI sign-in.',
    detail: out || String(e?.message || e),
  };
}

export async function probeAgyCli({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_MS) return cache.value;
  let value;
  try {
    await runAgyModels();
    value = { loggedIn: true, message: 'Antigravity CLI is signed in.', detail: null };
  } catch (e) {
    value = normalizeError(e);
  }
  value.checkedAt = now;
  cache = { at: now, value };
  return value;
}

export async function assertAgyCliLoggedIn() {
  const probe = await probeAgyCli({ force: true });
  if (probe.loggedIn) return;
  throw new Error(
    'Antigravity CLI is not signed in for Supercalm sessions. The Auth page Antigravity login only serves the local proxy credential; `agy` keeps its own session. Run `agy` in a terminal, choose Google OAuth, finish the browser/code flow, then start the session again.'
  );
}
