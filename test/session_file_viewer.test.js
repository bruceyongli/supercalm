import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FILE_REFERENCE_RX, localFilePath } from '../web/file-reference.js';
import { renderMarkdown } from '../web/common.js';
import { chromium } from 'playwright';

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
// Keep this standalone-repository fixture under a narrow home child so its authorization semantics
// do not change when the suite itself is materialized below the host temp root. Temp artifacts are
// intentionally governed by a separate exact-mention policy.
const externalParent = await mkdtemp(join(homedir(), '.aios-session-file-external-'));
const externalRoot = join(externalParent, 'standalone-repo');
const otherRoot = join(externalParent, 'mentioned-only-repo');
const writtenRoot = join(externalParent, 'written-output');
await mkdir(projectRoot);
await mkdir(artifactRoot);
await mkdir(join(externalRoot, 'research'), { recursive: true });
await mkdir(otherRoot);
await mkdir(writtenRoot);
await writeFile(join(projectRoot, 'report.md'), '# Project report\n');
await mkdir(join(projectRoot, 'dashboard', 'nested'), { recursive: true });
const dashboard = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><h1>Rendered dashboard</h1><p id="data"></p><a href="nested/REPORT.md">Read report</a><script src="app.js"></script>';
await writeFile(join(projectRoot, 'dashboard', 'index.html'), dashboard);
await writeFile(join(projectRoot, 'dashboard', 'app.js'), `
fetch('data.json').then(r => r.json()).then(data => document.querySelector('#data').textContent = data.status);
try { parent.document.title = 'UNSAFE'; window.parentAccessible = true; } catch { window.parentAccessible = false; }
try { localStorage.setItem('unsafe', 'yes'); window.storageAccessible = true; } catch { window.storageAccessible = false; }
fetch('/api/state').then(() => window.apiAccessible = true).catch(() => window.apiAccessible = false);
`);
await writeFile(join(projectRoot, 'dashboard', 'data.json'), '{"status":"Scripts and relative data loaded"}');
await writeFile(join(projectRoot, 'dashboard', 'nested', 'REPORT.md'), '# Nested report\n\n**Rendered**, not source.');
await writeFile(join(projectRoot, 'dashboard', '.private.json'), '{"secret":true}');
await writeFile(join(projectRoot, 'dashboard', 'private.db'), 'not a web asset');
await symlink(join(projectRoot, 'report.md'), join(projectRoot, 'dashboard', 'escape.md'));
const largeHtml = '<!doctype html><h1>Large dashboard</h1><!--' + 'x'.repeat(2 * 1024 * 1024) + '--><p>FULL FILE END</p>';
await writeFile(join(projectRoot, 'dashboard', 'large.html'), largeHtml);
await writeFile(join(projectRoot, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text x="10" y="20">Diagram</text></svg>');
const projectVideo = join(projectRoot, 'preview.mp4');
const videoBytes = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
await writeFile(projectVideo, videoBytes);
// Valid PCM WAV beyond the text viewer limit: audio must stream every sample.
const audioBytes = Buffer.alloc(44 + 2 * 1024 * 1024 + 128);
audioBytes.write('RIFF'); audioBytes.writeUInt32LE(audioBytes.length - 8, 4);
audioBytes.write('WAVEfmt ', 8); audioBytes.writeUInt32LE(16, 16);
audioBytes.writeUInt16LE(1, 20); audioBytes.writeUInt16LE(1, 22);
audioBytes.writeUInt32LE(48000, 24); audioBytes.writeUInt32LE(96000, 28);
audioBytes.writeUInt16LE(2, 32); audioBytes.writeUInt16LE(16, 34);
audioBytes.write('data', 36); audioBytes.writeUInt32LE(audioBytes.length - 44, 40);
await writeFile(join(projectRoot, 'preview.wav'), audioBytes);
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
const { prepareSessionStorage } = await import('../src/session_storage.js');
store.createProject({ id: 'p_files', name: 'files', path: projectRoot });
store.createSession({ id: 's_files', project_id: 'p_files', tool: 'codex', tmux: 'tmx_files', status: 'exited' });
store.updateSession('s_files', { codex_uuid: codexUuid });
store.addMessage('s_files', 'out', 'reply', `Generated image: ${artifact}`);
const managedStorage = await prepareSessionStorage('s_files');
const managedArtifact = join(managedStorage.artifacts, 'durable-report.md');
await writeFile(managedArtifact, '# Durable session report\n');
store.addMessage('s_files', 'out', 'reply', `Durable report: ${managedArtifact}`);
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

// Rendered URLs work directly and under /aios, preserve relative resources, stream
// full dashboards, and cannot expose other folders or hidden/unsupported files.
{
  await writeFile(join(projectRoot, 'dashboard', 'My report (最终).md'), '# Space and Unicode report\n');
  await writeFile(join(projectRoot, 'dashboard', 'nested', 'LINKS.md'), `# Links\n\n| Kind | Open |\n|---|---|\n| HTML | [Dashboard](<${join(projectRoot, 'dashboard', 'index.html')}>) |\n| Markdown | [Spaced](../My%20report%20(%E6%9C%80%E7%BB%88).md) |\n| Private | [Denied](<${privateArtifact}>) |`);
  const meta = await (await fileRequest('dashboard/index.html')).json();
  assert.equal(meta.renderInline, true);
  assert.equal((await (await fileRequest('dashboard/index.html')).json()).renderUrl, meta.renderUrl, 'stable rendered URL');
  const url = `${base}/${meta.renderUrl}`;
  const rendered = await fetch(url);
  assert.equal(rendered.status, 200);
  assert.match(rendered.headers.get('content-security-policy'), /sandbox allow-scripts allow-popups;/);
  assert.doesNotMatch(rendered.headers.get('content-security-policy'), /allow-same-origin|allow-top-navigation/);
  assert.equal(await rendered.text(), dashboard);
  assert.equal(await (await fetch(`${base}/aios/${meta.renderUrl}`)).text(), dashboard);
  assert.equal((await fetch(new URL('data.json', url))).status, 200);
  assert.match(await (await fetch(new URL('nested/REPORT.md', url))).text(), /<h1>Nested report<\/h1>/);
  for (const [name, status] of [['.private.json', 403], ['escape.md', 403], ['private.db', 415], ['%2e%2e%2freport.md', 403], ['%5c..%5creport.md', 403]]) {
    assert.equal((await fetch(new URL(name, url))).status, status, name);
  }
  assert.equal((await fetch(url.replace(/\/render\/[^/]+\//, '/render/unknown/'))).status, 404);
  assert.equal((await fetch(url.replace('/s_files/', '/s_missing/'))).status, 404);
  assert.match((await fetch(`${base}/${meta.viewUrl}`)).headers.get('content-type'), /^text\/plain/, 'Source must not execute HTML');
  const large = await (await fileRequest('dashboard/large.html')).json();
  assert.equal(large.truncated, true, 'source preview is bounded');
  assert.equal(await (await fetch(`${base}/${large.renderUrl}`)).text(), largeHtml, 'rendered HTML is never truncated');
  assert.equal(await (await fetch(`${base}/${large.downloadUrl}`)).text(), largeHtml, 'Download really returns the entire file');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    const fixture = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="styles.css"><div class="asset-detail-backdrop"><div class="asset-detail"><div id="preview" class="file-preview-host"></div></div></div><script type="module">import {mountFilePreview} from "./file-preview.js"; window.mountPreview = meta => mountFilePreview(document.querySelector("#preview"), meta);</script>';
    await page.route('**/__file-preview-test', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    await page.goto(`${base}/aios/__file-preview-test`);
    await page.waitForFunction(() => window.mountPreview);
    for (const width of [1440, 820, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(meta => window.mountPreview(meta), meta);
      const frame = page.frameLocator('.file-render-frame');
      await frame.locator('#data').filter({ hasText: 'Scripts and relative data loaded' }).waitFor();
      assert.equal(await frame.locator('h1').textContent(), 'Rendered dashboard');
      assert.equal(await frame.locator('body').evaluate(() => window.parentAccessible), false, 'sandbox cannot read/write AIOS parent');
      assert.equal(await frame.locator('body').evaluate(() => window.storageAccessible), false, 'sandbox cannot access AIOS local storage');
      await frame.locator('body').evaluate(() => new Promise(resolve => {
        const check = () => typeof window.apiAccessible === 'boolean' ? resolve() : setTimeout(check, 10); check();
      }));
      assert.equal(await frame.locator('body').evaluate(() => window.apiAccessible), false, 'preview scripts cannot call AIOS API');
      const box = await page.locator('.file-render-frame').boundingBox();
      assert.ok(box.width > 100 && box.x >= 0 && box.x + box.width <= width + 1, 'preview fits viewport');
      await page.locator('[data-file-mode="source"]').click();
      await page.locator('pre.asset-detail-text').waitFor();
      assert.equal(await page.locator('pre.asset-detail-text').textContent(), dashboard);
      assert.equal(await page.locator('.file-render-frame').count(), 0);
      await page.locator('[data-file-mode="rendered"]').click();
      await frame.locator('#data').filter({ hasText: 'Scripts and relative data loaded' }).waitFor();
    }
    const audioMeta = await (await fileRequest('preview.wav')).json();
    assert.equal(audioMeta.contentKind, 'audio');
    assert.equal(audioMeta.truncated, false);
    const fullAudio = await fetch(`${base}/${audioMeta.viewUrl}`);
    assert.equal(fullAudio.headers.get('content-type'), 'audio/wav');
    assert.equal(fullAudio.headers.get('x-aios-truncated'), null);
    assert.deepEqual(Buffer.from(await fullAudio.arrayBuffer()), audioBytes);
    const audioRange = await fetch(`${base}/${audioMeta.viewUrl}`, { headers: { range: 'bytes=0-43' } });
    assert.equal(audioRange.status, 206);
    assert.equal(audioRange.headers.get('content-range'), `bytes 0-43/${audioBytes.length}`);
    assert.deepEqual(Buffer.from(await audioRange.arrayBuffer()), audioBytes.subarray(0, 44));
    for (const width of [1440, 820, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(meta => window.mountPreview(meta), audioMeta);
      await page.waitForFunction(() => document.querySelector('audio')?.readyState >= 1);
      const player = page.locator('audio.asset-detail-audio');
      assert.equal(await player.getAttribute('controls'), '');
      assert.equal(await page.locator('[data-file-copy], [data-file-mode]').count(), 0, 'audio never exposes binary source as text');
      await player.evaluate(async audio => { await audio.play(); audio.currentTime = 2; });
      await page.waitForFunction(() => { const audio = document.querySelector('audio'); return !audio.paused && !audio.seeking && audio.currentTime >= 2; });
      const box = await player.boundingBox();
      assert.ok(box.width > 100 && box.x >= 0 && box.x + box.width <= width + 1, 'audio controls fit desktop, tablet, and phone');
      await player.evaluate(audio => audio.pause());
    }
    const tab = await browser.newPage();
    await tab.goto(`${base}/aios/${meta.renderUrl}`);
    await tab.waitForFunction(() => document.querySelector('#data').textContent.includes('loaded'));
    assert.equal(await tab.evaluate(() => window.storageAccessible), false, 'new-tab rendering retains CSP sandbox');
    const markdown = await (await fileRequest('report.md')).json();
    await page.evaluate(meta => window.mountPreview(meta), markdown);
    await page.frameLocator('.file-render-frame').locator('h1').filter({ hasText: 'Project report' }).waitFor();
    const linked = await (await fileRequest('dashboard/nested/LINKS.md')).json();
    await page.evaluate(meta => window.mountPreview(meta), linked);
    const documentFrame = page.frameLocator('.file-render-frame');
    await documentFrame.getByRole('link', { name: 'Dashboard', exact: true }).waitFor();
    for (const [name, expectedHeading] of [['Dashboard', 'Rendered dashboard'], ['Spaced', 'Space and Unicode report']]) {
      const popupPromise = page.waitForEvent('popup');
      await documentFrame.getByRole('link', { name, exact: true }).click();
      const popup = await popupPromise;
      await popup.locator('h1').filter({ hasText: expectedHeading }).waitFor();
      await popup.close();
    }
    const deniedHref = await documentFrame.getByRole('link', { name: 'Denied', exact: true }).getAttribute('href');
    assert.equal((await fetch(new URL(deniedHref, base))).status, 403, 'document links never bypass session file scope');
    const openResponse = await fileRequest('dashboard/index.html', '&open=1');
    assert.equal(openResponse.status, 200);
    assert.equal(await openResponse.text(), dashboard, 'direct open redirects through authorized rendered hosting');
    const svg = await (await fileRequest('diagram.svg')).json();
    await page.evaluate(meta => window.mountPreview(meta), svg);
    await page.frameLocator('.file-render-frame').locator('svg text').waitFor();
    assert.equal(await page.locator('[data-file-mode="source"]').count(), 1, 'SVG supports rendered/source switching');
    await page.evaluate(meta => window.mountPreview({ ...meta, renderInline: false }), markdown);
    await page.locator('pre.asset-detail-text').waitFor();
    assert.equal(await page.locator('[data-file-open]').getAttribute('href'), markdown.renderUrl, 'unsupported inline renderer still offers rendered new tab');
  } finally { await browser.close(); }
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

// AIOS-managed durable artifacts are scoped to their owning session and remain openable after its
// disposable scratch directory has been cleaned.
{
  const response = await fileRequest(managedArtifact);
  assert.equal(response.status, 200);
  const meta = await response.json();
  assert.equal(meta.path, managedArtifact);
  assert.equal(meta.contentKind, 'text');
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
// sensitive workdir remains insufficient. The fixture stays outside the test checkout so a promotion
// subject materialized below the host temp root exercises the same standalone-repository policy.
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
  assert.match(src, /story-body a\[href\]/);
  assert.match(src, /const href = link\.getAttribute\('href'\)/);
  assert.match(src, /const path = localFilePath\(href\)/);
  assert.match(src, /shouldUseFileViewer\(href, path\)/);
  assert.match(src, /openFileViewer\(path\)/);
  const preview = readFileSync(new URL('../web/file-preview.js', import.meta.url), 'utf8');
  assert.match(src, /mountFilePreview\(/, 'all viewers use the shared rendered/source controls');
  assert.match(preview, /meta\.contentKind === 'video'/);
  assert.match(preview, /<video class="asset-detail-video" controls playsinline preload="metadata"/);
  assert.match(src, /data-story-file/);
  assert.match(src, /window\.open\(url, '_blank', 'noopener,noreferrer'\)/, 'terminal web URLs open in a safe new tab');
  assert.match(preview, /target="_blank" rel="noopener noreferrer"/, 'file viewer offers a safe new-tab action');
}

console.log('session_file_viewer.test ok');
await runGit('worktree', 'remove', '--force', linkedRoot).catch(() => {});
await rm(linkedParent, { recursive: true, force: true });
await rm(externalParent, { recursive: true, force: true });
process.exit(0);
