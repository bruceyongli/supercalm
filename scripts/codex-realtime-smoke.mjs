#!/usr/bin/env node
// Live probe for the installed Codex CLI's experimental realtime App Server API.
// It prints auth type and transcripts only; it never reads or prints the API key.
await import('../src/config.js'); // loads the existing gitignored data/aios.env
const { CodexAppServerClient } = await import('../src/codex_realtime_client.js');

const client = new CodexAppServerClient({
  codexBin: process.env.AIOS_CODEX_BIN || 'codex',
  cwd: process.cwd(),
  requestTimeoutMs: 20_000,
});

function realtimeStarted(threadId) {
  return Promise.race([
    client.waitFor('thread/realtime/started', { predicate: (p) => p.threadId === threadId, timeoutMs: 30_000 }),
    client.waitFor('thread/realtime/error', { predicate: (p) => p.threadId === threadId, timeoutMs: 30_000 })
      .then((p) => { throw new Error(p.message); }),
  ]);
}

try {
  await client.initialize();
  const [account, voices] = await Promise.all([client.account(), client.voices()]);
  const authType = account?.account?.type || 'none';
  console.log(`Codex App Server: connected`);
  console.log(`Auth type: ${authType}`);
  console.log(`Realtime v2 voices: ${voices.v2.length} (default ${voices.defaultV2})`);
  if (authType !== 'apiKey') {
    console.error('BLOCKED: realtime conversation requires API-key auth.');
    console.error('Add OPENAI_API_KEY to the existing gitignored data/aios.env, restart AIOS, and rerun this command.');
    process.exitCode = 2;
  } else {
    const started = await client.request('thread/start', {
      cwd: process.cwd(),
      ephemeral: true,
      baseInstructions: 'You are a concise realtime voice test. Do not use tools.',
    });
    const threadId = started.thread.id;
    const accepted = realtimeStarted(threadId);
    await client.request('thread/realtime/start', {
      threadId,
      outputModality: 'text',
      transport: { type: 'websocket' },
      version: 'v2',
      includeStartupContext: false,
      clientManagedHandoffs: true,
      prompt: 'Reply briefly. Never add a canned sign-off such as "Thank you." unless asked.',
    }, 30_000);
    await accepted;
    const transcript = client.waitFor('thread/realtime/transcript/done', {
      predicate: (p) => p.threadId === threadId && p.role === 'assistant',
      timeoutMs: 30_000,
    });
    await client.request('thread/realtime/appendText', {
      threadId,
      text: 'Reply with exactly: AIOS realtime is connected.',
    });
    console.log(`Transcript: ${(await transcript).text}`);
    await client.request('thread/realtime/stop', { threadId });
    console.log('Realtime smoke: PASS');
  }
} catch (error) {
  console.error(`Realtime smoke: FAIL — ${error.message}`);
  process.exitCode = 1;
} finally {
  client.close();
}
