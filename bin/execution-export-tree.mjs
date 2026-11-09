#!/usr/bin/env node
import { spawn } from 'node:child_process';
// tarfile preserves nested relative symlinks. Only the explicitly validated top
// entries are materialized; broad tar --dereference would recurse through cycles.
const script = `import os,sys,json,base64,tarfile
root=sys.argv[1]; links={p['name']:p for p in json.loads(base64.b64decode(sys.argv[2]))}
class StableTar(tarfile.TarFile):
 def addfile(self,info,fileobj=None):
  before=os.fstat(fileobj.fileno()) if fileobj else None
  super().addfile(info,fileobj)
  if before:
   after=os.fstat(fileobj.fileno())
   if (before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns): raise RuntimeError('Source changed during transfer')
with StableTar.open(fileobj=sys.stdout.buffer,mode='w|',dereference=False,format=tarfile.PAX_FORMAT) as archive:
 for name in sorted(os.listdir(root)):
  if name=='.git': continue
  target=os.path.join(root,name)
  if name in links:
   p=links[name]; st=os.lstat(p['path'])
   if os.path.realpath(target)!=p['path'] or st.st_ino!=p['inode'] or st.st_dev!=p['device']: raise RuntimeError('Dependency identity changed')
   target=p['path']
   if p.get('localLink'):
    info=tarfile.TarInfo('./'+name); info.type=tarfile.SYMTYPE; info.linkname=p['localLink']; archive.addfile(info)
    archive.add(target,arcname='./'+p['localLink'],recursive=True)
    continue
  archive.add(target,arcname='./'+name,recursive=True)
`;
const child = spawn('/usr/bin/python3', ['-c', script, process.argv[2], process.argv[3]], { stdio: ['ignore', 'inherit', 'inherit'] });
const stop = () => child.kill('SIGTERM');
process.on('SIGTERM', stop); process.on('SIGINT', stop);
child.on('error', () => { process.exitCode = 1; });
child.on('close', code => { process.exitCode = code || (code === 0 ? 0 : 1); process.off('SIGTERM', stop); process.off('SIGINT', stop); });
