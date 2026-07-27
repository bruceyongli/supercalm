import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { route, json, readJson } from './server.js';
import { ROOT } from './config.js';
import { CodexAppServerClient, publicRealtimeError } from './codex_realtime_client.js';

const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 2;
const MAX_SDP_CHARS = 256 * 1024;
const BRIDGE_MODEL = process.env.AIOS_CODEX_VOICE_MODEL || 'gpt-5.3-codex-spark';
const VOICES = new Set([
  'alloy', 'arbor', 'ash', 'ballad', 'breeze', 'cedar', 'coral', 'cove', 'echo', 'ember',
  'juniper', 'maple', 'marin', 'sage', 'shimmer', 'sol', 'spruce', 'vale', 'verse',
]);
const DEFAULT_PROMPT = `You are the experimental realtime voice interface for AIOS.
Speak naturally and concisely. Optimize for low latency: acknowledge briefly, then answer.
Never add a canned sign-off such as "Thank you." unless the user explicitly asks for it.
This is a proof of concept. Explain uncertainty instead of inventing state or claiming an action succeeded.`;
const BRIDGE_INSTRUCTIONS = `You are Codex speaking through the AIOS voice bridge.
Answer the user's spoken request directly in one or two short, natural sentences.
Do not use tools, inspect files, or narrate reasoning unless the user explicitly asks for coding work.
Never add a canned sign-off such as "Thank you." unless the user asks for it.
Return plain speakable text only: no markdown, URLs, file paths, or emoji.`;

const sessions = new Map();
let statusCache = null;

function codexBinary() {
  if (process.env.AIOS_CODEX_BIN) return process.env.AIOS_CODEX_BIN;
  for (const candidate of [
    join(homedir(), '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/usr/bin/codex',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return 'codex';
}

export function createCodexRealtimeClient(options = {}) {
  return new CodexAppServerClient({
    codexBin: codexBinary(),
    cwd: process.env.AIOS_CODEX_REALTIME_CWD || ROOT,
    ...options,
  });
}

function waitForRealtimeSignal(client, threadId, timeoutMs = 25_000) {
  return new Promise((resolve, reject) => {
    const onSdp = (params) => {
      if (params.threadId !== threadId) return;
      cleanup();
      resolve(params);
    };
    const onError = (params) => {
      if (params.threadId !== threadId) return;
      cleanup();
      reject(new Error(params.message || 'Codex realtime startup failed'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`thread/realtime/sdp notification timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      client.off('thread/realtime/sdp', onSdp);
      client.off('thread/realtime/error', onError);
    };
    client.on('thread/realtime/sdp', onSdp);
    client.on('thread/realtime/error', onError);
  });
}

export async function negotiateCodexRealtime({
  client,
  sdp,
  voice = 'marin',
  version = 'v2',
  prompt = DEFAULT_PROMPT,
}) {
  await client.initialize();
  const account = await client.account();
  if (account?.account?.type !== 'apiKey') {
    throw new Error('realtime conversation requires API key auth');
  }
  const started = await client.request('thread/start', {
    cwd: process.env.AIOS_CODEX_REALTIME_CWD || ROOT,
    ephemeral: true,
    baseInstructions: 'This is a low-latency voice session. Follow the realtime prompt and do not claim unverified actions.',
  });
  const threadId = started?.thread?.id;
  if (!threadId) throw new Error('Codex App Server did not return a thread id');

  const answer = waitForRealtimeSignal(client, threadId);
  await Promise.all([
    client.request('thread/realtime/start', {
      threadId,
      outputModality: 'audio',
      transport: { type: 'webrtc', sdp },
      version,
      voice,
      includeStartupContext: false,
      clientManagedHandoffs: true,
      prompt,
    }, 30_000),
    answer,
  ]);
  const remote = await answer;
  return { threadId, sdp: remote.sdp, voice, version };
}

async function inspectCapability() {
  const client = createCodexRealtimeClient();
  try {
    await client.initialize();
    const [account, voices] = await Promise.all([client.account(), client.voices()]);
    const authType = account?.account?.type || 'none';
    const nativeReady = authType === 'apiKey';
    const bridgeReady = authType === 'chatgpt' || authType === 'apiKey';
    return {
      ok: true,
      experimental: true,
      ready: nativeReady || bridgeReady,
      nativeReady,
      bridgeReady,
      mode: nativeReady ? 'native' : bridgeReady ? 'bridge' : null,
      authType,
      voices,
      bridgeModel: BRIDGE_MODEL,
      setup: bridgeReady
        ? null
        : 'Codex is not authenticated on this host. Sign in to the installed Codex CLI, then restart AIOS.',
    };
  } finally {
    client.close();
  }
}

function destroySession(id, { notify = true } = {}) {
  const session = sessions.get(id);
  if (!session) return Promise.resolve(false);
  sessions.delete(id);
  return (async () => {
    if (notify && session.kind === 'native') {
      try {
        await session.client.request('thread/realtime/stop', { threadId: session.threadId }, 3000);
      } catch {}
    }
    session.client.close();
    return true;
  })();
}

function getSession(id) {
  const session = sessions.get(id);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    destroySession(id).catch(() => {});
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

route('GET', '/api/codex-realtime/status', async (req, res) => {
  try {
    if (!statusCache || Date.now() - statusCache.at > 10_000) {
      statusCache = { at: Date.now(), value: await inspectCapability() };
    }
    json(res, 200, statusCache.value);
  } catch (error) {
    const out = publicRealtimeError(error);
    json(res, out.status, { ok: false, ready: false, error: out.message, code: out.code });
  }
});

route('POST', '/api/codex-realtime/start', async (req, res) => {
  if (sessions.size >= MAX_SESSIONS) {
    return json(res, 429, { error: 'The realtime lab already has two active sessions.', code: 'session-limit' });
  }
  const body = await readJson(req).catch(() => null);
  const sdp = String(body?.sdp || '');
  const voice = String(body?.voice || 'marin');
  if (!sdp.startsWith('v=0') || sdp.length > MAX_SDP_CHARS) {
    return json(res, 400, { error: 'A valid WebRTC SDP offer is required.', code: 'invalid-sdp' });
  }
  if (!VOICES.has(voice)) {
    return json(res, 400, { error: 'Unsupported realtime voice.', code: 'invalid-voice' });
  }

  const client = createCodexRealtimeClient();
  try {
    const negotiated = await negotiateCodexRealtime({ client, sdp, voice });
    const id = randomUUID();
    const session = {
      id,
      kind: 'native',
      client,
      threadId: negotiated.threadId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    sessions.set(id, session);
    const close = () => {
      if (sessions.get(id) === session) sessions.delete(id);
      client.close();
    };
    client.once('thread/realtime/closed', close);
    client.once('transport/error', close);
    json(res, 201, {
      ok: true,
      id,
      threadId: negotiated.threadId,
      sdp: negotiated.sdp,
      voice: negotiated.voice,
      version: negotiated.version,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    client.close();
    const out = publicRealtimeError(error);
    json(res, out.status, { ok: false, error: out.message, code: out.code });
  }
});

route('POST', '/api/codex-realtime/bridge/start', async (req, res) => {
  if (sessions.size >= MAX_SESSIONS) {
    return json(res, 429, { error: 'The voice lab already has two active sessions.', code: 'session-limit' });
  }
  const client = createCodexRealtimeClient();
  try {
    await client.initialize();
    const account = await client.account();
    if (!['chatgpt', 'apiKey'].includes(account?.account?.type)) {
      throw new Error('Codex is not authenticated');
    }
    const startedAt = performance.now();
    const started = await client.request('thread/start', {
      cwd: process.env.AIOS_CODEX_REALTIME_CWD || ROOT,
      ephemeral: true,
      model: BRIDGE_MODEL,
      baseInstructions: BRIDGE_INSTRUCTIONS,
    }, 30_000);
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error('Codex App Server did not return a thread id');
    const id = randomUUID();
    const session = {
      id,
      kind: 'bridge',
      client,
      threadId,
      model: started.model || BRIDGE_MODEL,
      busy: false,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    sessions.set(id, session);
    const close = () => {
      if (sessions.get(id) === session) sessions.delete(id);
      client.close();
    };
    client.once('transport/error', close);
    json(res, 201, {
      ok: true,
      id,
      threadId,
      mode: 'bridge',
      model: session.model,
      startupMs: Math.round(performance.now() - startedAt),
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    client.close();
    const out = publicRealtimeError(error);
    json(res, out.status, { ok: false, error: out.message, code: out.code });
  }
});

async function runBridgeTurn(session, text) {
  if (session.busy) {
    const error = new Error('The previous Codex voice turn is still running.');
    error.status = 409;
    error.code = 'turn-busy';
    throw error;
  }
  session.busy = true;
  const startedAt = performance.now();
  let output = '';
  let firstTokenAt = 0;
  let turnId = null;
  const onDelta = (params) => {
    if (params.threadId !== session.threadId || (turnId && params.turnId !== turnId)) return;
    if (!firstTokenAt) firstTokenAt = performance.now();
    output += params.delta || '';
  };
  let cancelOutcome;
  const outcome = new Promise((resolve, reject) => {
    const matches = (params, id) => params.threadId === session.threadId && (!turnId || id === turnId);
    const onComplete = (params) => {
      if (!matches(params, params.turn?.id)) return;
      cleanup();
      resolve(params);
    };
    const onError = (params) => {
      if (!matches(params, params.turnId)) return;
      cleanup();
      reject(new Error(params.error?.message || 'Codex voice turn failed'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Codex voice turn timed out after 60000ms'));
    }, 60_000);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      session.client.off('turn/completed', onComplete);
      session.client.off('server/error', onError);
    };
    cancelOutcome = cleanup;
    session.client.on('turn/completed', onComplete);
    session.client.on('server/error', onError);
  });
  // A server error can arrive just before the turn/start response. Attach a
  // rejection observer immediately; the awaited promise below still carries it.
  outcome.catch(() => {});
  session.client.on('item/agentMessage/delta', onDelta);
  try {
    const started = await session.client.request('turn/start', {
      threadId: session.threadId,
      input: [{ type: 'text', text }],
      effort: 'low',
    }, 60_000);
    turnId = started?.turn?.id || null;
    await outcome;
    const answer = output.trim();
    if (!answer) throw new Error('Codex returned an empty voice response');
    return {
      text: answer,
      model: session.model,
      firstTokenMs: firstTokenAt ? Math.round(firstTokenAt - startedAt) : null,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    cancelOutcome?.();
    session.client.off('item/agentMessage/delta', onDelta);
    session.busy = false;
  }
}

route('POST', '/api/codex-realtime/:id/bridge/turn', async (req, res, { id }) => {
  const session = getSession(id);
  if (!session || session.kind !== 'bridge') {
    return json(res, 404, { error: 'No active Codex voice bridge.', code: 'session-not-found' });
  }
  const body = await readJson(req).catch(() => ({}));
  const text = String(body.text || '').trim();
  if (!text || text.length > 4000) {
    return json(res, 400, { error: 'Text must be between 1 and 4000 characters.' });
  }
  try {
    json(res, 200, { ok: true, ...(await runBridgeTurn(session, text)) });
  } catch (error) {
    if (error.status) return json(res, error.status, { ok: false, error: error.message, code: error.code });
    const out = publicRealtimeError(error);
    json(res, out.status, { ok: false, error: out.message, code: out.code });
  }
});

route('POST', '/api/codex-realtime/:id/text', async (req, res, { id }) => {
  const session = getSession(id);
  if (!session) return json(res, 404, { error: 'No active realtime session.', code: 'session-not-found' });
  const body = await readJson(req).catch(() => ({}));
  const text = String(body.text || '').trim();
  if (!text || text.length > 4000) return json(res, 400, { error: 'Text must be between 1 and 4000 characters.' });
  try {
    await session.client.request('thread/realtime/appendText', { threadId: session.threadId, text });
    json(res, 202, { ok: true });
  } catch (error) {
    const out = publicRealtimeError(error);
    json(res, out.status, { ok: false, error: out.message, code: out.code });
  }
});

route('POST', '/api/codex-realtime/:id/stop', async (req, res, { id }) => {
  const stopped = await destroySession(id);
  json(res, stopped ? 200 : 404, stopped ? { ok: true } : { error: 'No active realtime session.' });
});

const gc = setInterval(() => {
  for (const [id, session] of sessions) {
    if (Date.now() > session.expiresAt) destroySession(id).catch(() => {});
  }
}, 60_000);
gc.unref?.();
process.once('exit', () => {
  for (const session of sessions.values()) session.client.close();
  sessions.clear();
});
