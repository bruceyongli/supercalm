import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const { gitProbe, urlProbe } = await import('../src/agents/probes.js');

// git probe: real repo truth with provenance
const repo = mkdtempSync(join(tmpdir(), 'probe-repo-'));
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
writeFileSync(join(repo, 'f'), 'x\n'); g('add', '.'); g('commit', '-qm', 'base');
let p = await gitProbe(repo);
assert.equal(p.type, 'git');
assert.equal(p.collector, 'system/probes@1');
assert.equal(p.result.ok, true);
assert.equal(p.result.sha, g('rev-parse', 'HEAD'), 'sha comes from git, not prose');
assert.equal(p.result.dirty, false);
writeFileSync(join(repo, 'f'), 'changed\n');
p = await gitProbe(repo);
assert.equal(p.result.dirty, true, 'dirty state is observed, not asserted');
assert.ok(p.digest && p.at && p.ms >= 0, 'provenance envelope complete');
assert.equal((await gitProbe('/nonexistent-repo-path')).result.ok, false, 'failure is an envelope, not a throw');

// url probe: live status + body digest
const srv = createServer((req, res) => { res.writeHead(200); res.end('hello-evidence'); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/x`;
const u = await urlProbe(url);
assert.deepEqual([u.type, u.result.ok, u.result.status], ['url', true, 200]);
assert.equal(u.result.bodyBytes, 'hello-evidence'.length);
const u2 = await urlProbe(url);
assert.equal(u.result.bodyDigest, u2.result.bodyDigest, 'same body => same digest (change detection)');
srv.close();
assert.equal((await urlProbe('http://127.0.0.1:1/none', { timeoutMs: 500 })).result.ok, false, 'unreachable is an envelope');

console.log('probes: all assertions passed');
