import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), 'aios-archive-hardlinks-')));
process.env.AIOS_DATA = join(root, 'data');
process.env.AIOS_LIVE_STORAGE_CONFIG = join(root, 'no-storage.json');
try {
  const { validateArchive } = await import('../src/execution_bundle.js');
  const fixture = `import tarfile,io,json,sys
with tarfile.open(sys.argv[1],'w') as archive:
 for entry in json.loads(sys.argv[2]):
  info=tarfile.TarInfo(entry['path']); info.mode=0o644
  if entry.get('kind') in ('hardlink','symlink'):
   info.type=tarfile.LNKTYPE if entry['kind']=='hardlink' else tarfile.SYMTYPE
   info.linkname=entry['target']; archive.addfile(info)
  else:
   data=entry.get('content','fixture').encode(); info.size=len(data); archive.addfile(info,io.BytesIO(data))
`;
  const file = { path: './package/bin/program', content: 'original executable bytes' };
  const link = { path: './package/platform/program', kind: 'hardlink', target: './package/bin/program' };
  let count = 0;
  const archive = async entries => {
    const path = join(root, `fixture-${count++}.tar`);
    await exec('/usr/bin/python3', ['-c', fixture, path, JSON.stringify(entries)]);
    return path;
  };
  const tar = await archive([file, link]);
  await validateArchive(tar);
  const destination = join(root, 'unpacked'); await mkdir(destination);
  await exec('/usr/bin/tar', ['-xf', tar, '-C', destination]);
  assert.equal(await readFile(join(destination, 'package/platform/program'), 'utf8'), file.content);
  assert.equal((await stat(join(destination, 'package/platform/program'))).ino,
    (await stat(join(destination, 'package/bin/program'))).ino, 'the safe internal hardlink is preserved');
  await validateArchive(await archive([file, { ...link, target: 'package/bin/program' }]));
  await validateArchive(await archive([file, { ...link, target: '././package/bin/program' }]));

  for (const target of ['../outside', '/outside', './package/../../../outside', 'package\\outside']) {
    await assert.rejects(validateArchive(await archive([file, { ...link, target }])), /External symlink dependency|Link escapes checkout/);
  }
  await assert.rejects(validateArchive(await archive([file, { ...link, target: './missing' }])), /Invalid archive hardlink/);
  await assert.rejects(validateArchive(await archive([file,
    { path: './alias', kind: 'symlink', target: 'package/bin/program' },
    { ...link, target: './alias' }])), /Invalid archive hardlink/);
  await assert.rejects(validateArchive(await archive([file, link,
    { path: './copy', kind: 'hardlink', target: './package/platform/program' }])), /Invalid archive hardlink/);
  await assert.rejects(validateArchive(await archive([file,
    { path: './alias', kind: 'symlink', target: 'package' },
    { ...link, path: './alias/injected' }])), /Archive member beneath a symlink/);
  await assert.rejects(validateArchive(await archive([file, { ...file, path: 'package/bin/program' }])), /Repeated archive member/);
  console.log('execution_archive_hardlinks: normalized internal targets, extraction identity and unsafe target rejection passed');
} finally { await rm(root, { recursive: true, force: true }); }
