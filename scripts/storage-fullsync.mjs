// Explicit Spark storage setup. Run as administrator on the storage server, never during live I/O.
import { readFileSync, writeFileSync, copyFileSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
const file = '/etc/samba/smb.conf';
const [share, root] = process.argv.slice(2);
if (!/^[a-zA-Z0-9_-]+$/.test(share || '') || !root?.startsWith('/') || /[\r\n]/.test(root)) throw Error('Usage: storage-fullsync.mjs DEDICATED_SHARE ABSOLUTE_SHARE_ROOT');
if (process.getuid() !== 0) throw new Error('Storage-server administrator required');
const old = readFileSync(file, 'utf8');
const sections = [...old.matchAll(/^\s*\[([^\]]+)\].*$/gm)];
const section = sections.find(s => s[1] === share);
if (!section || sections.filter(s => s[1] === share).length !== 1) throw new Error('Expected dedicated AIOS share');
const end = sections.find(s => s.index > section.index)?.index ?? old.length;
const body = old.slice(section.index, end);
if (body.match(/^\s*path\s*=\s*(.+)$/m)?.[1]?.trim() !== root) throw new Error('Unexpected share target');
if (/^\s*fruit:time machine\s*=\s*yes\s*$/m.test(body)) { console.log('Full-sync already enabled'); process.exit(0); }
if (/^\s*fruit:time machine\s*=/m.test(body)) throw new Error('Existing custom policy; inspect before changing');
const next = old.slice(0, section.index) + body.trimEnd() + '\n   fruit:time machine = yes\n\n' + old.slice(end);
const candidate = `${file}.aios-candidate-${process.pid}`;
writeFileSync(candidate, next, { mode: 0o600, flag: 'wx' });
execFileSync('testparm', ['-s', candidate], { stdio: 'ignore' });
const backup = `${file}.aios-before-fullsync-${Date.now()}`;
copyFileSync(file, backup, constants.COPYFILE_EXCL);
try {
  writeFileSync(file, next, { mode: 0o644 });
  execFileSync('testparm', ['-s', file], { stdio: 'ignore' });
  execFileSync('systemctl', ['reload', 'smbd'], { stdio: 'inherit' });
} catch (error) {
  copyFileSync(backup, file);
  execFileSync('systemctl', ['reload', 'smbd'], { stdio: 'inherit' });
  throw error;
}
console.log('AIOS-only share advertises durable full-sync; other shares unchanged. Original configuration backed up.');
