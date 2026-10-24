// Operator storage preferences. Existing aliases are never moved or removed here.
import { readFile, mkdir, lstat, stat, realpath, writeFile, open, mkdtemp, rm, symlink, readlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR, ROOT } from './config.js';
import { liveStorageConfig, liveStorageConfigFile, liveStorageStatus, validateLiveStorage } from './live_storage.js';
import { durableJson } from './storage_migration.js';
import { withStorageConfigLock } from './storage_provision.js';
import { worktreeRoot } from './worktrees.js';
import { currentDiskCapacity } from './disk_pressure.js';

const exec = promisify(execFile);
const missing = error => { if (error.code !== 'ENOENT') throw error; return null; };
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
function credentialInput(value) {
  const password = value == null ? '' : String(value);
  if (!password || password.length > 4096 || /[\r\n\0]/.test(password)) {
    throw problem('Enter a file-sharing password without newline characters (up to 4096 characters).');
  }
  return password;
}
export function storageDeviceInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem('Enter a storage device configuration.');
  const label = String(body.label || '').trim(), account = String(body.account || '').trim();
  if (!label || label.length > 80 || /[\r\n\0]/.test(label)) throw problem('Enter a device name (up to 80 characters).');
  if (!account || account.length > 120 || /[\r\n\0]/.test(account)) throw problem('Enter the file-sharing account.');
  let url, share;
  try { url = new URL(String(body.url || '').trim()); share = decodeURIComponent(url.pathname); }
  catch { throw problem('Enter an SMB share URL, such as smb://192.168.1.20/storage.'); }
  if (url.protocol !== 'smb:' || !url.hostname || url.username || url.password || url.search || url.hash
      || !/^\/[^/]+\/?$/.test(share) || /[\r\n\0\\]/.test(share) || /^\/\.{1,2}\/?$/.test(share)) {
    throw problem('Use an SMB share URL without embedded credentials, query parameters, or subfolders.');
  }
  const sizeGiB = Number(body.sizeGiB ?? 1024);
  if (!Number.isInteger(sizeGiB) || sizeGiB < 32 || sizeGiB > 16384) throw problem('Volume maximum must be between 32 and 16384 GiB. It grows as files are stored.');
  const password = body.password == null ? '' : String(body.password);
  if (password.length > 4096 || /[\r\n\0]/.test(password)) throw problem('The password contains unsupported characters.');
  return { label, account, url: url.href.replace(/\/$/, ''), sizeGiB, password };
}

export function createStorageSettings({ data = DATA_DIR, projectParent = homedir(), worktrees = worktreeRoot(),
  current = liveStorageConfig, currentFile = liveStorageConfigFile, status = liveStorageStatus,
  connect = connectStorageDevice, saveCredential = saveStorageCredential, platform = process.platform,
  pinnedConfig = !!process.env.AIOS_LIVE_STORAGE_CONFIG } = {}) {
  const file = join(data, 'storage-settings.json'), devicesRoot = join(data, 'storage-devices');
  let queue = Promise.resolve();
  const serial = action => { const next = queue.then(action); queue = next.catch(() => {}); return next; };
  const load = async () => {
    const settings = (await read(file).catch(missing)) || { version: 1, defaultDevice: current()?.id || 'local', devices: [] };
    if (settings.version !== 1 || typeof settings.defaultDevice !== 'string' || !Array.isArray(settings.devices)
        || settings.devices.some(d => !d || !/^storage-[a-f0-9-]{36}$/.test(d.id))) throw new Error('Invalid storage settings');
    return settings;
  };
  const save = async settings => { await mkdir(data, { recursive: true }); await durableJson(file, settings); };
  const deviceConfig = async (id, settings) => {
    const live = current();
    if (live?.id === id) return { config: live, file: currentFile(), existing: true };
    const device = settings.devices.find(d => d.id === id);
    if (!device) throw problem('Storage device not found.', 404);
    return { config: validateLiveStorage(await read(join(devicesRoot, id, 'config.json'))),
      file: join(devicesRoot, id, 'config.json'), existing: false };
  };
  const policies = config => [
    { kind: 'project', sourceParent: projectParent, targetParent: join(config.mount, 'projects'), exclude: ['aios', 'proxy'] },
    { kind: 'worktree', sourceParent: worktrees, targetParent: join(config.mount, 'worktrees') },
    { kind: 'session', sourceParent: join(data, 'session-storage'), targetParent: join(config.mount, 'session-storage') },
    { kind: 'artifacts', sourceParent: join(data, 'session-artifacts'), targetParent: join(config.mount, 'session-artifacts') },
  ];
  async function snapshot() {
    const settings = await load(), live = current();
    const devices = [];
    const add = (config, extra = {}) => {
      const state = status(config);
      devices.push({ id: config.id, label: config.label || extra.label || config.id,
        url: config.url, account: config.account, mount: config.mount, image: config.image,
        sizeGiB: extra.sizeGiB || null, credentials: 'macOS Keychain', current: live?.id === config.id,
        available: !!state?.available, status: state, ...extra });
    };
    if (live) add(live);
    for (const device of settings.devices) {
      if (device.id === live?.id) continue;
      try {
        const { config } = await deviceConfig(device.id, settings); add(config, { label: device.label, sizeGiB: device.sizeGiB });
      } catch {
        devices.push({ id: device.id, label: device.label, sizeGiB: device.sizeGiB, current: false,
          available: false, status: { available: false, error: 'The saved device configuration is unavailable.' } });
      }
    }
    let migration = null;
    if (live?.retainDuringMigration) {
      const roots = await Promise.all(live.mappings.map(async m => {
        const id = createHash('sha256').update(m.source).digest('hex').slice(0, 20);
        const j = await read(join(live.journalRoot, id + '.json')).catch(missing);
        return { source: m.source, active: !!m.active, state: j?.state || 'planned',
          bytes: j?.verification?.bytes || null, error: j?.state === 'complete' ? null : j?.error || null };
      }));
      migration = { running: true, completed: roots.filter(r => r.active && r.state === 'complete').length, total: roots.length, roots };
    }
    return { defaultDevice: settings.defaultDevice, localIsFactoryDefault: true, devices, migration,
      local: currentDiskCapacity(data), setupSupported: platform === 'darwin',
      scope: 'New project folders, worktrees, temporary files and artifacts. Existing folders retain their registered location. Agents, databases and runtime configuration stay local.' };
  }
  return {
    snapshot,
    add: body => serial(async () => {
      if (platform !== 'darwin') throw problem('Automatic SMB/APFS setup currently requires a macOS AIOS host. Local storage remains available.');
      const input = storageDeviceInput(body);
      if (!input.password) throw problem('Enter the file-sharing password. It is saved only in macOS Keychain.');
      const settings = await load();
      if (settings.devices.length >= 8) throw problem('Up to eight remote devices can be configured.');
      const id = 'storage-' + randomUUID(), control = join(devicesRoot, id), shareMount = join(control, 'share'), mount = join(control, 'volume');
      const config = validateLiveStorage({ version: 1, id, label: input.label, url: input.url, account: input.account,
        service: 'aios-storage-' + id, helper: join(devicesRoot, 'storage-mount'), shareMount, mount,
        image: join(shareMount, 'aios-' + id + '.sparsebundle'), journalRoot: join(control, 'journals'),
        statusFile: join(control, 'status.json'), mappings: [], newRoots: [] });
      await mkdir(control, { recursive: true, mode: 0o700 });
      await saveCredential(config, input.password); input.password = '';
      await durableJson(join(control, 'config.json'), config);
      settings.devices.push({ id, label: input.label, sizeGiB: input.sizeGiB, createdAt: Date.now() });
      await save(settings);
      return { id, ...(await snapshot()) };
    }),
    connect: id => serial(async () => {
      const settings = await load(), entry = await deviceConfig(id, settings);
      // Existing storage is checked/reconnected by its original watcher. Never create,
      // detach, reformat, or change its already-owned disk image from Settings.
      await connect(entry.config, entry.file, { existing: entry.existing,
        sizeGiB: settings.devices.find(d => d.id === id)?.sizeGiB || 1024 });
      if (!status(entry.config)?.available) throw problem('Storage has not confirmed a healthy connection. Check the device and saved password, then retry.', 503);
      return snapshot();
    }),
    updateCredential: (id, body) => serial(async () => {
      if (platform !== 'darwin') throw problem('Storage credentials require macOS Keychain on this host.');
      const settings = await load(), entry = await deviceConfig(id, settings);
      let password = credentialInput(body?.password);
      try { await saveCredential(entry.config, password); }
      finally { password = ''; }
      return snapshot();
    }),
    select: id => serial(async () => {
      if (typeof id !== 'string' || !id) throw problem('Select a storage device.');
      const settings = await load(), live = current();
      if (live?.retainDuringMigration) throw problem('A storage migration is in progress. Its destination is locked until verification and session recovery finish.', 409);
      const lockedLiveFile = live ? currentFile() : null;
      const assertCurrent = () => {
        const active = current();
        if ((active?.id || null) !== (live?.id || null) || currentFile() !== lockedLiveFile
            || active?.mount !== live?.mount || active?.journalRoot !== live?.journalRoot) {
          throw problem('The active storage configuration changed. Refresh and retry.', 409);
        }
        if (active?.retainDuringMigration) throw problem('A storage migration started. Retry after it finishes.', 409);
        return active;
      };
      if (id === 'local') {
        if (live) await withStorageConfigLock(live, async () => {
          const latest = assertCurrent();
          await durableJson(lockedLiveFile, { ...latest,
            storageSettingsNewRoots: latest.newRoots?.length ? latest.newRoots : latest.storageSettingsNewRoots || [], newRoots: [] });
        });
      } else {
        const entry = await deviceConfig(id, settings), config = entry.config;
        if (!status(config)?.available) throw problem('Test the connection successfully before selecting this device.', 409);
        if (!entry.existing && pinnedConfig) throw problem('Storage is pinned by the host configuration. Update that configuration before selecting a different device.', 409);
        const select = async () => withStorageConfigLock(config, async () => {
          const active = assertCurrent();
          if (active && active.id !== id && active.mappings.length) throw problem('Existing files are registered on another device. A verified migration is required before replacing that destination; no files have been moved.', 409);
          const latest = validateLiveStorage(await read(entry.file));
          if (latest.id !== id || latest.retainDuringMigration) throw problem('The selected storage configuration changed. Refresh and retry.', 409);
          if (!status(latest)?.available) throw problem('Storage became unavailable. Reconnect before selecting this device.', 409);
          // Preserve an imported destination layout; enable new per-session roots only
          // where there is not already a whole-root migration mapping.
          const newRoots = [...(latest.newRoots?.length ? latest.newRoots
            : latest.storageSettingsNewRoots?.length ? latest.storageSettingsNewRoots : policies(latest))];
          for (const policy of policies(latest).filter(p => ['session', 'artifacts'].includes(p.kind))) {
            if (!newRoots.some(p => p.kind === policy.kind) && !latest.mappings.some(m =>
              policy.sourceParent === m.source || policy.sourceParent.startsWith(m.source + '/'))) newRoots.push(policy);
          }
          const updated = validateLiveStorage({ ...latest, newRoots });
          delete updated.storageSettingsNewRoots;
          await durableJson(entry.file, updated);
          if (!entry.existing) await durableJson(join(data, 'live-storage.json'), { configFile: entry.file });
        });
        if (live && live.id !== id) await withStorageConfigLock(live, select);
        else await select();
      }
      settings.defaultDevice = id; await save(settings); return snapshot();
    }),
  };
}

async function run(file, args, timeout = 60000) {
  try { return await exec(file, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }); }
  catch { throw problem('Storage command did not complete. Existing files were not moved. Check the device, credentials and available space.', 502); }
}
async function saveStorageCredential(config, password) {
  if (!await lstat(config.helper).catch(missing)) {
    await mkdir(dirname(config.helper), { recursive: true, mode: 0o700 });
    await run('/usr/bin/clang', ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'Security', '-framework', 'NetFS',
      '-o', config.helper, join(ROOT, 'scripts/storage-mount.m')]);
  }
  await new Promise((resolve, reject) => {
    const child = spawn(config.helper, ['save', config.service, config.account], { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(problem('The Keychain helper could not start.', 502)); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(problem('Password could not be saved in macOS Keychain.', 502)); });
    child.stdin.end(password + '\n');
  });
}
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
async function connectStorageDevice(config, file, { existing, sizeGiB }) {
  if (existing) { await run(process.execPath, [join(ROOT, 'bin/storage-mount-watch.mjs'), file, '--once'], 90000); return; }
  const mounted = async (path, type) => (await run('/sbin/mount', [], 5000)).stdout.split('\n').some(line => line.includes(` on ${path} (${type},`));
  for (const path of [config.shareMount, config.mount]) {
    await mkdir(path, { mode: 0o500 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw problem('The managed mountpoint was replaced.', 409);
  }
  if (!await mounted(config.shareMount, 'smbfs')) await run(config.helper, ['mount', config.service, config.account, config.url, config.shareMount]);
  if (!await mounted(config.shareMount, 'smbfs')) throw problem('The SMB share did not mount.', 503);
  if (!await lstat(config.image).catch(missing)) await run('/usr/bin/hdiutil', ['create', '-size', sizeGiB + 'g', '-type', 'SPARSEBUNDLE', '-fs', 'APFS', '-volname', 'Supercalm storage', config.image], 120000);
  if (!await mounted(config.mount, 'apfs')) await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-owners', 'on', '-mountpoint', config.mount, config.image], 90000);
  const info = (await run('/usr/bin/hdiutil', ['info'], 15000)).stdout;
  if (!info.split(/^=+$/m).some(block => block.match(/^image-path\s*:\s*(.+)$/m)?.[1]?.trim() === config.image
    && block.split('\n').some(line => line.startsWith('/dev/') && line.trimEnd().endsWith('\t' + config.mount)))) throw problem('Mounted image identity does not match this device.', 409);
  const marker = join(config.mount, '.aios-storage-id');
  await writeFile(marker, config.id + '\n', { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if ((await readFile(marker, 'utf8')).trim() !== config.id) throw problem('Storage identity mismatch. Existing files have been retained.', 409);
  // Only our unique probe is removed. Never clean another folder, old image or device.
  const fixture = await mkdtemp(join(config.mount, '.aios-connection-test-'));
  try {
    const path = join(fixture, '中文 sample'), content = randomUUID();
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await symlink('中文 sample', join(fixture, 'link'));
    if (await readFile(path, 'utf8') !== content || ((await stat(path)).mode & 0o777) !== 0o600
      || await readlink(join(fixture, 'link')) !== '中文 sample') throw problem('Storage failed its file-content or permission check.', 409);
  } finally { await rm(fixture, { recursive: true, force: false }); }
  await run(process.execPath, [join(ROOT, 'bin/storage-mount-watch.mjs'), file, '--once'], 90000);
  const label = 'ai.aios.' + config.id, directory = join(homedir(), 'Library', 'LaunchAgents');
  await mkdir(directory, { recursive: true });
  const plist = join(directory, label + '.plist');
  const contents = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(ROOT, 'bin/storage-mount-watch.mjs'))}</string><string>${xml(file)}</string></array><key>WorkingDirectory</key><string>${xml(ROOT)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`;
  await writeFile(plist, contents, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if ((await lstat(plist)).isSymbolicLink() || await readFile(plist, 'utf8') !== contents) {
    throw problem('A different startup job already uses this device identity. It was not overwritten.', 409);
  }
  const loaded = await exec('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { timeout: 5000 }).then(() => true, () => false);
  if (!loaded) await run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plist], 15000);
}

export const storageSettings = createStorageSettings();
