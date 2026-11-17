// Managed SSH aliases for an execution device. Reuse an already-authorized local identity;
// never copy private keys, passwords, global env files, or alter a destination's authorized_keys.
import { mkdir, lstat, readFile, writeFile, rename, unlink, realpath } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const unsafePath = /[\x00-\x1f\x7f"\\%$*?]/;
export function connectionSpec(input) {
  const value = { alias: input.alias, host: input.host, user: input.user,
    port: Number(input.port ?? 22), identityFile: input.identityFile };
  for (const key of ['alias', 'host', 'user']) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(value[key] || '')) throw Error('Invalid SSH ' + key);
  }
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw Error('Invalid SSH port');
  if (!isAbsolute(value.identityFile || '') || unsafePath.test(value.identityFile)) throw Error('Use an absolute existing SSH identity path');
  return value;
}

const quote = value => '"' + value + '"';
async function ownedFile(path) {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o022) throw Error('Not an owned, safe regular file: ' + path);
    return { text: await readFile(path, 'utf8'), mode: st.mode & 0o777 };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function connectionConfig(input) {
  const c = connectionSpec(input);
  return `# Supercalm managed execution connection; credentials remain on this device.\nHost ${c.alias}\n`
    + `  HostName ${c.host}\n  User ${c.user}\n  Port ${c.port}\n  IdentityFile ${quote(c.identityFile)}\n`
    + '  IdentitiesOnly yes\n  IdentityAgent none\n  BatchMode yes\n  StrictHostKeyChecking yes\n  ConnectTimeout 10\nHost *\n';
}

export async function configureExecutionConnection({ root, home, spec, run = exec }) {
  const c = connectionSpec(spec);
  root = await realpath(root); home = await realpath(home);
  if (!root.startsWith(home + '/.local/share/') || unsafePath.test(root)) throw Error('Invalid managed execution root');
  if (!resolve(c.identityFile).startsWith(home + '/.ssh/') || await realpath(c.identityFile) !== resolve(c.identityFile)) throw Error('Identity must be an existing key in this device’s SSH directory');
  const identity = await lstat(c.identityFile);
  if (!identity.isFile() || identity.mode & 0o077 || identity.uid !== process.getuid()) throw Error('SSH identity must be a private, owned regular file');
  const sshDir = join(home, '.ssh'), config = join(sshDir, 'config'), directory = join(root, 'connections');
  const sshStat = await lstat(sshDir);
  if (!sshStat.isDirectory() || sshStat.uid !== process.getuid() || sshStat.mode & 0o022) throw Error('SSH directory must be owned, safe, and not a symlink');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.uid !== process.getuid() || directoryStat.mode & 0o077) throw Error('Connection directory must be private, owned and not a symlink');
  const lock = join(directory, '.configure.lock');
  await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    const path = join(directory, c.alias + '.conf'), record = join(directory, c.alias + '.json');
    const configFile = await ownedFile(config);
    const original = configFile?.text || '', mode = configFile?.mode ?? 0o600;
    const priorRecord = await ownedFile(record);
    const previous = priorRecord ? JSON.parse(priorRecord.text) : null;
    if (previous && JSON.stringify(connectionSpec(previous)) !== JSON.stringify(c)) throw Error('Connection already exists with different settings; no credentials/config replaced');
    const fragment = connectionConfig(c);
    const include = `# Supercalm execution connections\nHost *\nInclude ${quote(join(directory, '*.conf'))}\nHost *\n`;
    const priorFragment = (await ownedFile(path))?.text ?? null;
    if (priorFragment !== null && priorFragment !== fragment) throw Error('Managed SSH fragment changed; retained for review');
    const configured = (await run('/usr/bin/ssh', ['-G', '-F', original ? config : '/dev/null', c.alias], { timeout: 10000 })).stdout;
    const hostname = configured.match(/^hostname (.+)$/m)?.[1];
    if (!previous && hostname && hostname !== c.alias && !(original.startsWith(include) && priorFragment === fragment)) {
      throw Error('SSH alias is already configured outside Supercalm; retained unchanged');
    }
    // The known-host entry and identity must already work. Never accept a host key implicitly.
    await run('/usr/bin/ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes',
      '-o', 'IdentityAgent=none', '-o', 'ConnectTimeout=8', '-i', c.identityFile, '-p', String(c.port), `${c.user}@${c.host}`, 'true'], { timeout: 12000 });
    if (priorFragment === null) await writeFile(path, fragment, { flag: 'wx', mode: 0o600 });
    if (!original.startsWith(include)) {
      if (original.includes('# Supercalm execution connections')) throw Error('Existing connection include differs; retained unchanged');
      const fresh = (await ownedFile(config))?.text || '';
      if (fresh !== original) throw Error('SSH config changed while validating; retry without overwriting it');
      const temp = join(sshDir, `.supercalm-config-${process.pid}`);
      await writeFile(temp, include + original, { flag: 'wx', mode });
      try { await rename(temp, config); } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    await run('/usr/bin/ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', c.alias, 'true'], { timeout: 12000 });
    const result = { ...c, verifiedAt: Date.now(), credentialMode: 'existing-device-key', privateKeysCopied: false };
    if ((await ownedFile(record))?.text !== priorRecord?.text) throw Error('Connection record changed while validating');
    const tempRecord = record + '.tmp-' + process.pid;
    await writeFile(tempRecord, JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
    try { await rename(tempRecord, record); } finally { await unlink(tempRecord).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return result;
  } finally { await unlink(lock); }
}
