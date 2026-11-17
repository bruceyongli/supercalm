// Explicit, project-scoped build configuration. Values never enter HTTP responses, argv or logs.
import { lstatSync, realpathSync } from 'node:fs';
import { mkdir, lstat, readFile, writeFile, link, unlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';

function projectName(id) {
  if (!/^p_[a-zA-Z0-9_-]{1,100}$/.test(id || '')) throw Error('Invalid project identity');
  return id;
}
function privateFile(st) {
  return st.isFile() && st.uid === process.getuid() && !(st.mode & 0o077);
}
export function projectEnvironmentText(values) {
  if (!values || Array.isArray(values) || typeof values !== 'object') throw Error('Expected explicitly selected project variables');
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length || entries.length > 100) throw Error('Supply 1–100 selected project variables');
  const lines = entries.map(([key, value]) => {
    if (!/^[A-Z_][A-Z0-9_]{0,99}$/.test(key) || /^(AIOS_|NODE_|LD_|DYLD_)/.test(key)
        || ['PATH', 'HOME', 'SHELL', 'DEV_VARS'].includes(key)) throw Error('Invalid project variable name');
    if (typeof value !== 'string' || value.length > 65536 || /[\x00-\x1f\x7f]/.test(value)) throw Error('Unsupported project variable format: ' + key);
    const quote = !value.includes("'") ? "'" : !value.includes('"') ? '"' : null;
    if (!quote) throw Error('Project variable needs explicit dotenv encoding: ' + key);
    return key + '=' + quote + value + quote;
  });
  const text = lines.join('\n') + '\n';
  if (Buffer.byteLength(text) > 512 * 1024) throw Error('Project environment too large');
  const parsed = parseEnv(text);
  if (entries.some(([key, value]) => parsed[key] !== value)) throw Error('Project environment cannot be represented losslessly');
  return text;
}

// Only a private, operator-installed per-project file is advertised. No secret bytes are returned.
export function projectReleaseEnvironment(projectId, root = process.env.AIOS_EXECUTION_ROOT) {
  projectName(projectId);
  if (!root) return '';
  const dir = join(root, 'project-environments'), path = join(dir, projectId + '.env');
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.uid !== process.getuid() || st.mode & 0o077) throw Error('Project environment directory is not private');
    if (realpathSync(root) !== root) throw Error('Project environment root must be canonical');
    if (!privateFile(lstatSync(path))) throw Error('Project environment must be a private owned regular file');
    return path;
  } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

export async function installProjectEnvironment({ root, home, projectId, values }) {
  projectName(projectId);
  const text = projectEnvironmentText(values);
  root = await realpath(root); home = await realpath(home);
  if (!root.startsWith(home + '/.local/share/')) throw Error('Use this device’s managed execution root');
  const dir = join(root, 'project-environments'), path = join(dir, projectId + '.env');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (!st.isDirectory() || st.uid !== process.getuid() || st.mode & 0o077) throw Error('Project environment directory is not private');
  try {
    const existing = await lstat(path);
    if (!privateFile(existing)) throw Error('Existing project environment is not a private owned regular file');
    if (await readFile(path, 'utf8') !== text) throw Error('Existing project environment differs; retained unchanged');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const temp = join(dir, '.install-' + randomBytes(10).toString('hex'));
    await writeFile(temp, text, { flag: 'wx', mode: 0o600 });
    try { await link(temp, path); } finally { await unlink(temp); } // atomic no-clobber publication
  }
  return { projectId, path: projectReleaseEnvironment(projectId, root), keys: Object.keys(values).sort(), mode: '0600', valuesReturned: false };
}
