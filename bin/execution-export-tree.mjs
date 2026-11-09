#!/usr/bin/env node
import { spawn } from 'node:child_process';
// tarfile preserves nested relative symlinks. Only the explicitly validated top
// entries are materialized; broad tar --dereference would recurse through cycles.
const script = `import os,sys,json,base64,tarfile,stat,io,zipfile
from concurrent.futures import ThreadPoolExecutor
from collections import deque
root=sys.argv[1]; plan=json.loads(base64.b64decode(sys.argv[2]))
if isinstance(plan,list): plan={'links':plan}
links={p['name']:p for p in plan.get('links',[])}
excluded={p['path']:p for p in plan.get('excluded',[])}
report_extensions=('.md','.markdown','.txt','.html','.htm','.csv','.tsv','.rst','.adoc','.asciidoc')
def identity(st): return (st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_mode)
def stable_open(path,st):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 stream=os.fdopen(fd,'rb')
 if identity(os.fstat(stream.fileno()))!=identity(st):
  stream.close(); raise RuntimeError('Source changed before transfer')
 return stream
def walk(path,name):
 if plan.get('reportOnly'):
  if os.path.islink(path): return
  if not os.path.isdir(path) and not path.lower().endswith(report_extensions): return
 if plan.get('artifactDependencies') and not os.path.islink(path):
  base=os.path.basename(path)
  if os.path.isdir(path):
   if base=='node_modules' or (base in ('venv','.venv') and os.path.isfile(os.path.join(path,'pyvenv.cfg'))): return
   if base.endswith('.app') and os.path.isfile(os.path.join(path,'Contents','Info.plist')): return
  elif base.lower().endswith('.dmg'): return
  elif base.lower().endswith('.zip'):
   try:
    with zipfile.ZipFile(path) as archive:
     if any('/Contents/Info.plist' in n and '.app/' in n for n in archive.namelist()): return
   except zipfile.BadZipFile: pass
 if name.removeprefix('./') in excluded:
  saved=excluded[name.removeprefix('./')]; st=os.lstat(path)
  if st.st_ino!=saved['inode'] or st.st_dev!=saved['device']: raise RuntimeError('Cold source identity changed')
  return
 yield (path,name,None)
 if os.path.isdir(path) and not os.path.islink(path):
  for entry in sorted(os.scandir(path),key=lambda e:e.name):
   if plan.get('reportOnly'):
    if entry.is_dir(follow_symlinks=False): yield from walk(entry.path,name+'/'+entry.name)
    elif entry.name.lower().endswith(report_extensions) and entry.is_file(follow_symlinks=False): yield (entry.path,name+'/'+entry.name,None)
   elif entry.is_dir(follow_symlinks=False) or (name+'/'+entry.name).removeprefix('./') in excluded or (plan.get('artifactDependencies') and entry.name.lower().endswith(('.dmg','.zip'))): yield from walk(entry.path,name+'/'+entry.name)
   else: yield (entry.path,name+'/'+entry.name,None)
def entries():
 for name in sorted(os.listdir(root)):
  if name=='.git': continue
  target=os.path.join(root,name)
  if name in links:
   p=links[name]; st=os.lstat(p['path'])
   if os.path.realpath(target)!=p['path'] or st.st_ino!=p['inode'] or st.st_dev!=p['device']: raise RuntimeError('Dependency identity changed')
   target=p['path']
   if p.get('rebuild'):
    if p.get('localLink'):
     yield (None,'./'+name,p['localLink'])
     yield (None,'./'+p['localLink'],False)
    elif p.get('directory'): yield (None,'./'+name,False)
    continue
   if p.get('localLink'):
    yield (None,'./'+name,p['localLink'])
    yield from walk(target,'./'+p['localLink'])
    continue
  yield from walk(target,'./'+name)
def prepare(item):
 path,name,link=item; info=tarfile.TarInfo(name)
 if link is not None:
  if link is False:
   info.type=tarfile.DIRTYPE; info.mode=0o755
   return (info,None,None,None)
  info.type=tarfile.SYMTYPE; info.linkname=link
  return (info,None,None,None)
 st=os.lstat(path); info.mode=stat.S_IMODE(st.st_mode); info.uid=st.st_uid; info.gid=st.st_gid; info.mtime=st.st_mtime
 data=None
 if stat.S_ISDIR(st.st_mode): info.type=tarfile.DIRTYPE
 elif stat.S_ISLNK(st.st_mode): info.type=tarfile.SYMTYPE; info.linkname=os.readlink(path)
 elif stat.S_ISREG(st.st_mode):
  info.type=tarfile.REGTYPE; info.size=st.st_size
  if st.st_size<=2*1024*1024:
   with stable_open(path,st) as stream:
    data=stream.read(st.st_size+1)
    if len(data)!=st.st_size or identity(os.fstat(stream.fileno()))!=identity(st): raise RuntimeError('Source changed during transfer')
 else: raise RuntimeError('Special files are not portable')
 return (info,data,path,st)
def emit(archive,prepared):
 info,data,path,st=prepared
 if not info.isreg(): archive.addfile(info); return
 if data is not None: archive.addfile(info,io.BytesIO(data)); return
 with stable_open(path,st) as stream:
  archive.addfile(info,stream)
  if identity(os.fstat(stream.fileno()))!=identity(st): raise RuntimeError('Source changed during transfer')
# At most sixteen 2 MiB buffers, with eight reads in flight. Large files stream
# directly; no full-tree snapshot/cache or unbounded dependency buffers on bb1.
with ThreadPoolExecutor(max_workers=8) as pool,tarfile.open(fileobj=sys.stdout.buffer,mode='w|',dereference=False,format=tarfile.PAX_FORMAT) as archive:
 pending=deque()
 for item in entries():
  pending.append(pool.submit(prepare,item))
  if len(pending)>=16: emit(archive,pending.popleft().result())
 while pending: emit(archive,pending.popleft().result())
`;
const child = spawn('/usr/bin/python3', ['-c', script, process.argv[2], process.argv[3]], { stdio: ['ignore', 'inherit', 'inherit'] });
const stop = () => child.kill('SIGTERM');
process.on('SIGTERM', stop); process.on('SIGINT', stop);
child.on('error', () => { process.exitCode = 1; });
child.on('close', code => { process.exitCode = code || (code === 0 ? 0 : 1); process.off('SIGTERM', stop); process.off('SIGINT', stop); });
