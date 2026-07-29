import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FILE_REFERENCE_RX, localFilePath } from '../web/file-reference.js';
import { renderMarkdown } from '../web/common.js';

// Full URLs printed by an agent on this host map back to their local absolute path. Other hosts never
// do, and the terminal matcher keeps the full URL as one link instead of dropping the "https:" prefix.
{
  const host = 'bb1.taileabe0b.ts.net';
  const full = `https://${host}/tmp/mo-journey/prod-workflows.png`;
  assert.equal(localFilePath(full, host), '/tmp/mo-journey/prod-workflows.png');
  assert.equal(localFilePath('//bb1.taileabe0b.ts.net/tmp/report.md', host), '/tmp/report.md');
  assert.equal(localFilePath('docs/report.md', host), 'docs/report.md');
  assert.equal(localFilePath('file:///Users/bb1/project/report.md', host), '/Users/bb1/project/report.md');
  assert.equal(localFilePath('file://localhost/Users/bb1/project/report.md%3A42', host), '/Users/bb1/project/report.md');
  assert.equal(localFilePath('~/project/report.md:42:7', host), '~/project/report.md');
  assert.equal(localFilePath('/Users/bb1/project/report.md#L18C4', host), '/Users/bb1/project/report.md');
  assert.equal(localFilePath('https://elsewhere.test/tmp/secret.txt', host), '');
  assert.equal(localFilePath('file://elsewhere.test/tmp/secret.txt', host), '');
  FILE_REFERENCE_RX.lastIndex = 0;
  assert.equal(FILE_REFERENCE_RX.exec(`result: ${full}`)?.[0], full);
  FILE_REFERENCE_RX.lastIndex = 0;
  assert.equal(FILE_REFERENCE_RX.exec('result: file:///Users/bb1/project/report.md:42')?.[0],
    'file:///Users/bb1/project/report.md:42');
}

// Story reports autolink ordinary bare URLs into safe new-tab anchors without nesting an existing
// markdown link or turning inline code into a link.
{
  const html = renderMarkdown('Docs: https://example.com/guide?q=one&x=two. [Status](https://status.example.com) `https://code.example.com`');
  assert.match(html, /href="https:\/\/example\.com\/guide\?q=one&amp;x=two" target="_blank" rel="noopener noreferrer">https:\/\/example\.com\/guide\?q=one&amp;x=two<\/a>\./);
  assert.equal((html.match(/<a /g) || []).length, 2, 'bare URL plus markdown link, with no nested/double link');
  assert.match(html, /<code>https:\/\/code\.example\.com<\/code>/, 'inline-code URLs stay code');
  const files = renderMarkdown('[local](file:///Users/bb1/project/report.md) [home](~/project/report.md:42)');
  assert.match(files, /href="file:\/\/\/Users\/bb1\/project\/report\.md"/);
  assert.match(files, /href="~\/project\/report\.md:42"/);
}

const scratch = await mkdtemp(join(tmpdir(), 'aios-session-files-'));
const projectRoot = join(scratch, 'project');
const artifactRoot = join(scratch, 'artifacts');
await mkdir(join(process.cwd(), 'test-results'), { recursive: true });
const linkedParent = await mkdtemp(join(process.cwd(), 'test-results/session-file-worktree-'));
const linkedRoot = join(linkedParent, 'linked');
const externalParent = await mkdtemp(join(process.cwd(), 'test-results/session-file-external-'));
const externalRoot = join(externalParent, 'standalone-repo');
const otherRoot = join(externalParent, 'mentioned-only-repo');
const writtenRoot = join(externalParent, 'written-output');
await mkdir(projectRoot);
await mkdir(artifactRoot);
await mkdir(join(externalRoot, 'research'), { recursive: true });
await mkdir(otherRoot);
await mkdir(writtenRoot);
await writeFile(join(projectRoot, 'report.md'), '# Project report\n');
const projectVideo = join(projectRoot, 'preview.mp4');
const videoBytes = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
await writeFile(projectVideo, videoBytes);
const artifact = join(artifactRoot, 'result.png');
const privateArtifact = join(artifactRoot, 'private.txt');
await writeFile(artifact, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
await writeFile(privateArtifact, 'not mentioned by this session');
await symlink(privateArtifact, join(projectRoot, 'escape.txt'));
const git = promisify(execFile);
const runGit = (...args) => git('git', ['-C', projectRoot, ...args], { encoding: 'utf8' });
const runExternalGit = (...args) => git('git', ['-C', externalRoot, ...args], { encoding: 'utf8' });
await runGit('init', '-b', 'main');
await runGit('add', 'report.md', 'preview.mp4');
await runGit('-c', 'user.name=AIOS Test', '-c', 'user.email=aios-test@example.invalid', 'commit', '-m', 'fixture');
await runGit('worktree', 'add', '-b', 'linked-artifacts', linkedRoot);
await mkdir(join(linkedRoot, 'docs'));
const linkedReport = join(linkedRoot, 'docs', 'secondary-report.md');
const linkedPrivate = join(linkedRoot, 'docs', 'unmentioned.md');
const transcriptReport = join(linkedRoot, 'docs', 'transcript-report.md');
await writeFile(linkedReport, '# Secondary worktree report\n');
await writeFile(linkedPrivate, '# Not granted\n');
await writeFile(transcriptReport, '# Transcript-only report\n');
const externalReport = join(externalRoot, 'research', 'result.md');
const externalRelativeReport = join(externalRoot, 'research', 'relative.md');
const externalPrivate = join(externalRoot, 'research', 'unmentioned.md');
const externalMissing = join(externalRoot, 'research', 'moved.md');
const mentionedOnly = join(otherRoot, 'not-operated.md');
const writtenOutput = join(writtenRoot, 'patch-result.json');
const unwrittenOutput = join(writtenRoot, 'private.json');
await writeFile(externalReport, '# Standalone repository result\n');
await writeFile(externalRelativeReport, '# Relative standalone result\n');
await writeFile(externalPrivate, '# Not mentioned\n');
await writeFile(mentionedOnly, '# Mention alone is insufficient\n');
await writeFile(writtenOutput, '{"passed":true}\n');
await writeFile(unwrittenOutput, '{"private":true}\n');
await runExternalGit('init', '-b', 'main');
await runExternalGit('add', 'research');
await runExternalGit('-c', 'user.name=AIOS Test', '-c', 'user.email=aios-test@example.invalid',
  'commit', '-m', 'standalone fixture');
const codexUuid = '12345678-1234-1234-1234-123456789abc';
const codexSessions = join(scratch, 'codex-sessions', '2026', '07', '27');
await mkdir(codexSessions, { recursive: true });
await writeFile(
  join(codexSessions, `rollout-2026-07-27T10-00-00-${codexUuid}.jsonl`),
  [
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'git status --short', workdir: externalRoot }),
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'pwd', workdir: '/etc' }),
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'patch_apply_end',
        success: true,
        changes: { [writtenOutput]: { type: 'add' } },
      },
    },
    {
      type: 'response_item',
      payload: {
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: [
            `Transcript artifact: ${transcriptReport}`,
            `Standalone artifact: ${externalReport}`,
            'Relative standalone artifact: research/relative.md',
            `Moved standalone artifact: ${externalMissing}`,
            'Moved relative artifact: research/moved.md',
            `Mentioned but never operated: ${mentionedOnly}`,
            `Exact patch receipt: ${writtenOutput}`,
            'Sensitive mention: /etc/passwd',
          ].join('\n'),
        }],
      },
    },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n',
);

process.env.AIOS_DATA = join(scratch, 'data');
process.env.AIOS_CODEX_SESSIONS_DIR = join(scratch, 'codex-sessions');
// Force this small fixture through the same streaming Full History fallback used by 32+ MB rollouts.
process.env.AIOS_SESSION_FILE_EVIDENCE_TAIL_BYTES = '1024';
const port = 31000 + Math.floor(Math.random() * 7000);
process.env.AIOS_PORT = String(port);

const store = await import('../src/store.js');
store.createProject({ id: 'p_files', name: 'files', path: projectRoot });
store.createSession({ id: 's_files', project_id: 'p_files', tool: 'codex', tmux: 'tmx_files', status: 'exited' });
store.updateSession('s_files', { codex_uuid: codexUuid });
store.addMessage('s_files', 'out', 'reply', `Generated image: ${artifact}`);
const { featureReady } = await import('../src/server.js');
await featureReady;

const base = `http://127.0.0.1:${port}`;
async function fileRequest(path, suffix = '') {
  return fetch(`${base}/api/session/s_files/file?path=${encodeURIComponent(path)}${suffix}`);
}
async function waitForRoutes() {
  for (let i = 0; i < 100; i++) {
    const response = await fileRequest('report.md').catch(() => null);
    if (response?.headers.get('content-type')?.includes('application/json')) return response;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('session file route did not load');
}

// Project files retain the original viewer behavior.
{
  const response = await waitForRoutes();
  assert.equal(response.status, 200);
  const meta = await response.json();
  assert.equal(meta.path, 'report.md');
  assert.equal(meta.contentKind, 'text');
}

// Videos are identified as previewable media and streamed with byte-range support. Range responses
// are essential for Safari/iOS seeking and avoid buffering a large generated movie in server memory.
{
  const response = await fileRequest('preview.mp4');
  assert.equal(response.status, 200);
  const meta = await response.json();
  assert.equal(meta.contentKind, 'video');
  assert.equal(meta.binary, false);
  assert.equal(meta.truncated, false);
  const rawUrl = `${base}/${meta.viewUrl}`;
  const range = await fetch(rawUrl, { headers: { range: 'bytes=2-5' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-type'), 'video/mp4');
  assert.equal(range.headers.get('accept-ranges'), 'bytes');
  assert.equal(range.headers.get('content-range'), `bytes 2-5/${videoBytes.length}`);
  assert.equal(range.headers.get('content-length'), '4');
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), videoBytes.subarray(2, 6));
  const suffix = await fetch(rawUrl, { headers: { range: 'bytes=-3' } });
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), videoBytes.subarray(-3));
  const invalid = await fetch(rawUrl, { headers: { range: 'bytes=99-' } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), `bytes */${videoBytes.length}`);
}

// A session-mentioned temp artifact can be previewed and served raw.
{
  const response = await fileRequest(artifact);
  assert.equal(response.status, 200);
  const meta = await response.json();
  assert.equal(meta.path, artifact);
  assert.equal(meta.contentKind, 'image');
  const raw = await fetch(`${base}/${meta.viewUrl}`);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get('content-type'), 'image/png');
  assert.equal((await raw.arrayBuffer()).byteLength, 8);
  const missing = join(artifactRoot, 'not-written-yet.md');
  store.addMessage('s_files', 'out', 'reply', `Pending report: ${missing}`);
  assert.equal((await fileRequest(missing)).status, 404);
}

// A full path explicitly reported by this session can be read from another Git-registered worktree of
// the same project. Merely being in that sibling worktree is insufficient without the exact mention.
{
  store.addMessage('s_files', 'out', 'reply', `Documentation: [secondary report](${linkedReport})`);
  const response = await fileRequest(linkedReport);
  assert.equal(response.status, 200);
  const meta = await response.json();
  assert.equal(meta.path, linkedReport);
  assert.equal(meta.contentKind, 'text');
  assert.equal((await fileRequest(linkedPrivate)).status, 403,
    'unmentioned files in a same-project sibling worktree remain private');
  const transcriptResponse = await fileRequest(transcriptReport);
  assert.equal(transcriptResponse.status, 200,
    'a path in this session’s bound native transcript is accepted even when absent from compact messages');
  assert.equal((await transcriptResponse.json()).path, transcriptReport);
}

// A bound native transcript can prove that the session operated in a separate standalone repository.
// Exact absolute and relative report links work; mention alone, an unmentioned sibling, or a broad
// sensitive workdir remains insufficient.
{
  const response = await fileRequest(externalReport);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).path, externalReport);
  assert.equal((await fileRequest('research/relative.md')).status, 200);
  assert.equal((await fileRequest(externalPrivate)).status, 403);
  assert.equal((await fileRequest(mentionedOnly)).status, 403);
  assert.equal((await fileRequest('/etc/passwd')).status, 403);
  assert.equal((await fileRequest(externalMissing)).status, 404);
  assert.equal((await fileRequest('research/moved.md')).status, 404);

  const fileUrl = `file://${externalReport}`;
  assert.equal((await fileRequest(fileUrl)).status, 200);
  const homePath = `~/${relative(homedir(), externalReport)}`;
  assert.equal((await fileRequest(homePath)).status, 200);
  assert.equal((await fileRequest(`${externalReport}:42:7`)).status, 200);
}

// A successful structured patch receipt grants only that exact safe output, not its directory.
{
  assert.equal((await fileRequest(writtenOutput)).status, 200);
  assert.equal((await fileRequest(unwrittenOutput)).status, 403);
}

// Temp files not present in session evidence stay private. Project symlinks cannot escape the project
// root into that temp area either.
{
  store.addMessage('s_files', 'out', 'reply', `Different artifact: ${privateArtifact}.backup`);
  assert.equal((await fileRequest(privateArtifact)).status, 403);
  assert.equal((await fileRequest('escape.txt')).status, 403);
}

// Story markdown links are delegated into the same viewer instead of opening the host root in a tab.
{
  const src = readFileSync(new URL('../web/session.js', import.meta.url), 'utf8');
  assert.match(src, /story-body\.md a\[href\]/);
  assert.match(src, /const href = link\.getAttribute\('href'\)/);
  assert.match(src, /const path = localFilePath\(href\)/);
  assert.match(src, /shouldUseFileViewer\(href, path\)/);
  assert.match(src, /openFileViewer\(path\)/);
  assert.match(src, /meta\.contentKind === 'video'/);
  assert.match(src, /<video class="asset-detail-video" controls playsinline preload="metadata"/);
  assert.match(src, /data-story-file/);
  assert.match(src, /window\.open\(url, '_blank', 'noopener,noreferrer'\)/, 'terminal web URLs open in a safe new tab');
  assert.match(src, /target="_blank" rel="noopener">Open tab ↗<\/a>/, 'file viewer offers a new-tab action');
}

console.log('session_file_viewer.test ok');
await runGit('worktree', 'remove', '--force', linkedRoot).catch(() => {});
await rm(linkedParent, { recursive: true, force: true });
await rm(externalParent, { recursive: true, force: true });
process.exit(0);
