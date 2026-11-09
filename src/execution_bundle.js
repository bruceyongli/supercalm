// Portable, complete Git checkouts. Bundles contain objects, not worktree pointers.
// The working-file archive is separate so staged/unstaged/untracked work can survive a move.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { migrationError } from './execution_identity.js';
import { executionGit } from './execution_git.js';
import { coldPathspec } from './execution_cold.js';

const exec = promisify(execFile);
export async function gitEvidence(path, options = {}) {
  const { excludedPaths = [], ...gitOptions } = options;
  const run = (args, extra = {}) => executionGit(path, args, { ...gitOptions, ...extra });
  const optional = args => run(args).catch(error => { if (error.exitCode === 1 || error.exitCode === 2) return ''; throw error; });
  const top = (await run(['rev-parse', '--show-toplevel'])).trim();
  if (await realpath(top) !== await realpath(path)) throw migrationError('Select the complete repository root, not a subdirectory');
  const [head, branch, index, origin, splitIndex, sparse, userName, userEmail] = await Promise.all([
    run(['rev-parse', 'HEAD']), optional(['symbolic-ref', '--short', '-q', 'HEAD']),
    run(['rev-parse', '--path-format=absolute', '--git-path', 'index']),
    optional(['config', '--get', 'remote.origin.url']), run(['rev-parse', '--shared-index-path']),
    optional(['config', '--get', 'core.sparseCheckout']),
    optional(['config', '--get', 'user.name']), optional(['config', '--get', 'user.email']),
  ]);
  let fragment = '';
  await run(['ls-files', '--stage', '-z'], { onData: chunk => {
    fragment += chunk.toString('utf8'); const rows = fragment.split('\0'); fragment = rows.pop();
    if (rows.some(row => row.startsWith('160000 '))) throw migrationError('This checkout has Git submodules. Initialize a self-contained copy before device migration.', 'execution-submodule');
  } });
  if (splitIndex.trim() || sparse.trim() === 'true') throw migrationError('Sparse/split-index checkouts need a full local checkout before device migration', 'execution-special-index');
  // Serial full-tree scans avoid competing for the network disk. Keep the exact
  // original hash framing (status followed by diff), including all untracked paths.
  const hash = createHash('sha256');
  await run(['status', '--porcelain=v2', '-z', '--untracked-files=all', ...coldPathspec(excludedPaths)], { label: 'working-tree scan', onData: chunk => hash.update(chunk) });
  await run(['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD'], { label: 'change scan', onData: chunk => hash.update(chunk) });
  const cleanOrigin = origin.trim();
  // Never serialize an embedded password/token from a legacy Git remote.
  if (/^https?:\/\/[^/]*@/i.test(cleanOrigin)) throw migrationError('Remove credentials embedded in the Git remote URL before migrating');
  return { head: head.trim(), branch: branch.trim() || null,
    statusHash: hash.digest('hex'), index: index.trim(), origin: cleanOrigin || null,
    identity: { name: userName.trim(), email: userEmail.trim() } };
}
export async function assertLocalCheckout(path) {
  const root = await realpath(path);
  const home = await lstat(homedir());
  const info = await lstat(root);
  if (info.dev !== home.dev || !(await lstat(join(root, '.git'))).isDirectory()) {
    throw migrationError('Execution requires a complete repository on the local SSD', 'execution-checkout-not-local');
  }
  for (const name of ['objects/info/alternates', 'commondir']) {
    try { await lstat(join(root, '.git', name)); throw migrationError('The checkout depends on another Git object store', 'execution-checkout-linked'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return root;
}
export function safeArchiveName(name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\') || name.startsWith('/')
    || name.split('/').some(p => p === '..') || /[\r\n]/.test(name)) throw migrationError('Unsafe archive member', 'execution-archive-path');
  return name.replace(/^\.\//, '');
}
// Python's standard tar parser validates both names and link targets before extraction.
// No commands from the source repo, hooks, checkout filters or dependency installers run here.
export const archiveValidator = `import tarfile,sys,posixpath
links={}; members={}
with tarfile.open(sys.argv[1], 'r:*') as archive:
 for item in archive:
  name=item.name
  if name.startswith('/') or '\\\\' in name or any(p=='..' for p in name.split('/')) or any(c in name for c in '\\r\\n\\0'):
   raise RuntimeError('Unsafe archive member')
  if item.isdev() or item.isfifo(): raise RuntimeError('Special files are not portable')
  if '.git' in name.split('/') and sys.argv[2]!='data': raise RuntimeError('Git pointers are not working files')
  name=posixpath.normpath(name)
  if name in members and not item.isdir(): raise RuntimeError('Repeated archive member')
  members[name]=item
  if item.issym() or item.islnk():
   link=item.linkname
   target=posixpath.normpath(posixpath.join(posixpath.dirname(name) if item.issym() else '',link))
   if link.startswith('/') or target=='..' or target.startswith('../') or '\\\\' in link: raise RuntimeError('External symlink dependency: '+name)
   links[name]=link
def resolve_link(path,seen=()):
 parts=[]
 for part in path.split('/'):
  if part in ('','.'): continue
  if part=='..':
   if not parts: raise RuntimeError('Link escapes checkout')
   parts.pop(); continue
  parts.append(part); here='/'.join(parts)
  if here in links:
   if here in seen or len(seen)>64: raise RuntimeError('Cyclic archive link')
   item=members[here]
   target=posixpath.join(posixpath.dirname(here) if item.issym() else '',links[here])
   parts=resolve_link(target,seen+(here,))
 return parts
for name,item in members.items():
 parent=posixpath.dirname(name)
 if any('/'.join(parent.split('/')[:i]) in links for i in range(1,len(parent.split('/'))+1)):
  raise RuntimeError('Archive member beneath a symlink')
 if name in links: resolve_link(name)
 if item.islnk():
  # GNU tar commonly spells targets with './'; member keys are normalized above.
  target=posixpath.normpath(item.linkname)
  if target not in members or not members[target].isfile(): raise RuntimeError('Invalid archive hardlink')
`;
export async function validateArchive(file, { allowGit = false } = {}) {
  try {
    await exec('/usr/bin/python3', ['-c', archiveValidator, file, allowGit ? 'data' : 'tree'], { timeout: 120000, maxBuffer: 65536 });
  } catch (error) {
    // execFile's message begins with the complete Python program. Keep the
    // actual validation reason visible in the bounded handoff error instead.
    const reason = String(error.stderr || '').split('\n').findLast(line => line.startsWith('RuntimeError: '))?.slice(14, 400);
    throw migrationError(`Archive validation failed: ${reason || (error.killed ? 'validation timed out' : 'could not read archive')}; source files are retained`, 'execution-archive-invalid');
  }
}
export async function hashFile(file) {
  const hash = createHash('sha256'); let size = 0;
  for await (const bytes of createReadStream(file)) { hash.update(bytes); size += bytes.length; }
  return { size, sha256: hash.digest('hex') };
}
export async function assertNativeIdentity(file, tool, uuid) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    let found = false;
    for (const line of lines) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      const id = tool === 'codex' && row.type === 'session_meta' ? row.payload?.id : tool === 'claude' ? row.sessionId : null;
      if (!id) continue;
      if (id !== uuid) throw migrationError('Native transcript belongs to a different conversation');
      found = true;
      if (tool === 'codex') break;
    }
    if (!found) throw migrationError('Could not prove the native conversation identity');
  } finally { await handle.close(); }
}
export async function uploadExecutionPart(node, operation, part, source, { timeout = 60 * 60_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256'); let size = 0, settled = false, command = null, commandExit = null, receipt = null, stream, sourceEnded = false;
    const finish = error => {
      if (settled) return;
      if (!error && (!receipt || !sourceEnded || command && commandExit !== 0)) return;
      settled = true; clearTimeout(timer);
      if (error) { request.destroy(); stream?.destroy(); command?.kill('SIGTERM'); reject(error); }
      else {
        const sha256 = hash.digest('hex');
        if (receipt.size !== size || receipt.sha256 !== sha256) reject(migrationError('Transfer digest mismatch; source files are retained'));
        else resolvePromise({ size, sha256 });
      }
    };
    const request = http.request({ hostname: '127.0.0.1', port: node.localPort, method: 'PUT',
      path: `/api/execution/import/${operation}/${part}`, headers: { 'x-aios-node-token': node.token } }, response => {
      let body = '';
      response.on('data', b => { body += b; if (body.length > 65536) response.destroy(); });
      response.on('error', finish);
      response.on('end', () => {
        try { receipt = JSON.parse(body); if (response.statusCode !== 200) throw Error(receipt.error || 'Worker rejected transfer'); finish(); }
        catch (error) { finish(error); }
      });
    });
    // Slow sources may exceed an hour while still making progress. Bound stalls,
    // not total archive size; otherwise a healthy copy is discarded at 60 minutes.
    const timer = setTimeout(() => finish(Error('Device transfer stalled; source files are retained')), timeout);
    request.on('error', finish);
    // A cold Git export can prepare for minutes before writing its first byte.
    // Authenticate now: otherwise Node buffers these headers until stdout starts
    // and the worker's header deadline closes an apparently empty connection.
    request.flushHeaders();
    if (typeof source === 'string') stream = createReadStream(source);
    else {
      command = spawn(source.command, source.args, { cwd: source.cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', COPYFILE_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      // stderr can contain private paths; never forward command/environment dumps to the UI.
      command.stderr.resume();
      command.on('error', finish);
      command.on('close', code => { commandExit = code; if (code !== 0) finish(Error('Source archive changed or could not be read; original files are retained')); else finish(); });
      stream = command.stdout;
    }
    stream.on('error', finish);
    stream.on('data', bytes => { if (!settled) { timer.refresh(); hash.update(bytes); size += bytes.length; } });
    stream.on('end', () => { sourceEnded = true; finish(); });
    stream.pipe(request);
  });
}

export function workingArchive(path) {
  return { command: '/usr/bin/tar', args: ['--no-mac-metadata', '--exclude=./.git', '-cf', '-', '-C', path, '.'] };
}
export function committedArchive(path, head) {
  return { command: '/usr/bin/git', args: ['-C', path, 'archive', '--format=tar', head] };
}
export function gitBundle(path, git = {}) {
  return { command: process.execPath, args: [fileURLToPath(new URL('../bin/execution-export-git.mjs', import.meta.url)), path,
    Buffer.from(JSON.stringify({ head: git.head, index: git.index })).toString('base64')] };
}
