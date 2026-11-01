// Portable, complete Git checkouts. Bundles contain objects, not worktree pointers.
// The working-file archive is separate so staged/unstaged/untracked work can survive a move.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { migrationError } from './execution_identity.js';

const exec = promisify(execFile);
export async function gitEvidence(path) {
  const run = async args => (await exec('/usr/bin/git', ['-C', path, ...args], {
    timeout: 60000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })).stdout;
  const top = (await run(['rev-parse', '--show-toplevel'])).trim();
  if (await realpath(top) !== await realpath(path)) throw migrationError('Select the complete repository root, not a subdirectory');
  const [head, branch, status, index, origin, submodules, diff, splitIndex, sparse, userName, userEmail] = await Promise.all([
    run(['rev-parse', 'HEAD']), run(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => ''),
    run(['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    run(['rev-parse', '--path-format=absolute', '--git-path', 'index']),
    run(['remote', 'get-url', 'origin']).catch(() => ''), run(['ls-files', '--stage']),
    run(['diff', '--binary', 'HEAD']), run(['rev-parse', '--shared-index-path']),
    run(['config', '--get', 'core.sparseCheckout']).catch(() => ''),
    run(['config', '--get', 'user.name']).catch(() => ''), run(['config', '--get', 'user.email']).catch(() => ''),
  ]);
  if (/^160000 /m.test(submodules)) throw migrationError('This checkout has Git submodules. Initialize a self-contained copy before device migration.', 'execution-submodule');
  if (splitIndex.trim() || sparse.trim() === 'true') throw migrationError('Sparse/split-index checkouts need a full local checkout before device migration', 'execution-special-index');
  const cleanOrigin = origin.trim();
  // Never serialize an embedded password/token from a legacy Git remote.
  if (/^https?:\/\/[^/]*@/i.test(cleanOrigin)) throw migrationError('Remove credentials embedded in the Git remote URL before migrating');
  return { head: head.trim(), branch: branch.trim() || null,
    statusHash: createHash('sha256').update(status).update(diff).digest('hex'), index: index.trim(), origin: cleanOrigin || null,
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
  if '.git' in name.split('/'): raise RuntimeError('Git pointers are not working files')
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
 if item.islnk() and (item.linkname not in members or not members[item.linkname].isfile()):
  raise RuntimeError('Invalid archive hardlink')
`;
export async function validateArchive(file) {
  await exec('/usr/bin/python3', ['-c', archiveValidator, file], { timeout: 120000, maxBuffer: 65536 });
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
    const hash = createHash('sha256'); let size = 0, settled = false, command = null, commandExit = null, receipt = null;
    const finish = error => {
      if (settled) return;
      if (!error && (!receipt || command && commandExit !== 0)) return;
      settled = true; clearTimeout(timer);
      if (error) { request.destroy(); command?.kill('SIGTERM'); reject(error); }
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
    const timer = setTimeout(() => finish(Error('Device transfer timed out; source files are retained')), timeout);
    request.on('error', finish);
    let stream;
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
    stream.on('data', bytes => { hash.update(bytes); size += bytes.length; });
    stream.pipe(request);
  });
}

export function workingArchive(path) {
  return { command: '/usr/bin/tar', args: ['--no-mac-metadata', '--exclude=./.git', '-cf', '-', '-C', path, '.'] };
}
export function committedArchive(path, head) {
  return { command: '/usr/bin/git', args: ['-C', path, 'archive', '--format=tar', head] };
}
export function gitBundle(path) {
  return { command: '/usr/bin/git', args: ['-C', path, 'bundle', 'create', '-', '--all', 'HEAD'] };
}
