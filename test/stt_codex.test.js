import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// codexDictationAuth reads ~/.codex/auth.json fresh and classifies failures. Point it at a fixture via
// AIOS_CODEX_AUTH_FILE (must be set BEFORE importing the module — the path is read at import time).
const dir = await mkdtemp(join(tmpdir(), 'aios-codex-auth-'));
const file = join(dir, 'auth.json');
process.env.AIOS_CODEX_AUTH_FILE = file;
const { codexDictationAuth, codexSttAvailable, CodexSttError } = await import('../src/stt_codex.js');

// Build a JWT-ish access token with a given exp (seconds) and optional embedded account.
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (payload) => `x.${b64url(payload)}.y`;
const future = Math.floor(Date.now() / 1000) + 3600;
const past = Math.floor(Date.now() / 1000) - 3600;

const expectKind = async (kind) => {
  await assert.rejects(codexDictationAuth(), (e) => { assert.ok(e instanceof CodexSttError); assert.equal(e.kind, kind); return true; });
};

// missing file
await expectKind('no_file');
assert.equal(await codexSttAvailable(), false);

// malformed JSON
await writeFile(file, '{not json');
await expectKind('bad_json');

// no token
await writeFile(file, JSON.stringify({ tokens: {} }));
await expectKind('no_token');

// expired token
await writeFile(file, JSON.stringify({ tokens: { access_token: jwt({ exp: past }), account_id: 'acc_1' } }));
await expectKind('expired');

// valid, account from the file field (preferred over JWT claim)
await writeFile(file, JSON.stringify({ tokens: { access_token: jwt({ exp: future }), account_id: 'acc_file' } }));
let auth = await codexDictationAuth();
assert.equal(auth.account, 'acc_file');
assert.equal(await codexSttAvailable(), true);

// valid, account only in the JWT namespaced claim (fallback)
await writeFile(file, JSON.stringify({ tokens: { access_token: jwt({ exp: future, 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_jwt' } }) } }));
auth = await codexDictationAuth();
assert.equal(auth.account, 'acc_jwt');

// valid token but no account anywhere → no_account
await writeFile(file, JSON.stringify({ tokens: { access_token: jwt({ exp: future }) } }));
await expectKind('no_account');

console.log('stt_codex.test ok');
