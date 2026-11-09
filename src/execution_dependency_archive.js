// Derive an extraction-only tar on the worker's SSD. The received tar, its
// transfer receipt, the copied index and all source files remain unchanged.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, normalize } from 'node:path';
import { migrationError } from './execution_identity.js';
import { validateDependencyRebuildPolicy } from './execution_dependency_policy.js';

const exec = promisify(execFile);
const rebuildArchive = `import os,sys,json,base64,tarfile,posixpath,subprocess,copy
plan=json.loads(base64.b64decode(sys.argv[3])); original=sys.argv[1]; destination=sys.argv[2]
reserved='.aios/execution-rebuilt-dependencies'
def identity(st): return (st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns)
def inside(root,path): return path==root or path.startswith(root+'/')
def tracked(command,path):
 env=dict(os.environ,GIT_INDEX_FILE=plan['index'],GIT_OPTIONAL_LOCKS='0',GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL='/dev/null')
 env.pop('GIT_DIR',None); env.pop('GIT_WORK_TREE',None)
 result=subprocess.run(['/usr/bin/git','--literal-pathspecs','--git-dir='+plan['repository']+'/.git',*command,'--',path],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
 if result.returncode: raise RuntimeError('Cannot prove dependency Git ownership')
 return bool(result.stdout)
rebuilt=[]; before=os.stat(original,follow_symlinks=False); index_before=os.stat(plan['index'],follow_symlinks=False)
with os.fdopen(os.open(original,os.O_RDONLY|os.O_NOFOLLOW),'rb') as source,tarfile.open(fileobj=source,mode='r:') as archive:
 if identity(os.fstat(source.fileno()))!=identity(before): raise RuntimeError('Received archive changed before dependency rebuilding')
 members=archive.getmembers(); reserved_present=False
 for item in members:
  name=item.name
  if name.startswith('/') or chr(92) in name or any(p=='..' for p in name.split('/')) or any(c in name for c in '\\r\\n\\0'): raise RuntimeError('Unsafe dependency archive member')
  name=posixpath.normpath(name)
  if inside(reserved,name): reserved_present=True
  if not item.issym() or posixpath.basename(name)!='node_modules': continue
  link=item.linkname
  if chr(92) in link or any(c in link for c in '\\r\\n\\0'): continue
  relative=posixpath.normpath(posixpath.join(posixpath.dirname(name),link))
  if not link.startswith('/') and relative!='..' and not relative.startswith('../'): continue
  target=posixpath.normpath(link if link.startswith('/') else posixpath.join(plan['sourceRoot'],posixpath.dirname(name),link))
  if posixpath.basename(target)!='node_modules' or not any(inside(root,target) for root in plan['policy']['allowedSourceRoots']): continue
  if tracked(['ls-files','--cached','-z'],name) or tracked(['ls-tree','-r','--name-only','-z',plan['head']],name): raise RuntimeError('Tracked dependency link cannot be rebuilt: '+name)
  rebuilt.append({'path':name,'target':link,'localTarget':reserved+'/'+str(len(rebuilt))})
 if rebuilt:
  if reserved_present: raise RuntimeError('Managed dependency destination already exists; original archive retained')
  replacements={row['path']:row for row in rebuilt}
  if len(replacements)!=len(rebuilt): raise RuntimeError('Repeated dependency archive member')
  with open(destination,'xb') as output,tarfile.open(fileobj=output,mode='w|',format=tarfile.PAX_FORMAT) as portable:
   for item in members:
    info=copy.copy(item); info.pax_headers=dict(item.pax_headers)
    replacement=replacements.get(posixpath.normpath(info.name))
    if replacement:
     info.linkname=posixpath.relpath(replacement['localTarget'],posixpath.dirname(replacement['path']) or '.')
     info.pax_headers.pop('linkpath',None)
    if info.isfile():
     # Re-emit sparse files as ordinary bytes; never retain stale sparse offsets.
     info.pax_headers={k:v for k,v in info.pax_headers.items() if not k.startswith('GNU.sparse.')}
     info.sparse=None
     with archive.extractfile(item) as content: portable.addfile(info,content)
    else: portable.addfile(info)
   for path in [reserved]+[row['localTarget'] for row in rebuilt]:
    info=tarfile.TarInfo(path); info.type=tarfile.DIRTYPE; info.mode=0o755; portable.addfile(info)
 if identity(os.fstat(source.fileno()))!=identity(before) or identity(os.stat(original,follow_symlinks=False))!=identity(before): raise RuntimeError('Received archive changed during dependency rebuilding')
 if identity(os.stat(plan['index'],follow_symlinks=False))!=identity(index_before): raise RuntimeError('Copied Git index changed during dependency rebuilding')
print(json.dumps({'path':destination if rebuilt else original,'rebuilt':rebuilt}))
`;

export async function prepareDependencyWorkingArchive({ archive, destination, repository, index, head, sourceRoot, policy }) {
  policy = validateDependencyRebuildPolicy(policy);
  if (![archive, destination, repository, index, sourceRoot].every(path => typeof path === 'string' && isAbsolute(path)
      && normalize(path) === path && !/[\r\n\0]/.test(path)) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head || '')
      || archive === destination) throw migrationError('Invalid dependency archive repair scope');
  const plan = Buffer.from(JSON.stringify({ repository, index, head, sourceRoot, policy })).toString('base64');
  try {
    const { stdout } = await exec('/usr/bin/python3', ['-c', rebuildArchive, archive, destination, plan], {
      timeout: 30 * 60_000, maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const reason = String(error.stderr || '').trim().split('\n').at(-1)?.replace(/^\w+(?:Error|Exception):\s*/, '');
    throw migrationError(reason || 'Dependency archive could not be prepared; original files are retained');
  }
}
