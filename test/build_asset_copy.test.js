import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { copyFileSync as namedSync } from 'node:fs';
import { copyFile as namedPromise } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installBuildAssetCopies } from '../src/build_asset_copy.js';
import { buildCopyEnvironment } from '../src/build_copy_env.js';

const exec = promisify(execFile), repo = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'aios-build-copy-')));
const root = join(fixture, 'project with spaces'), input = join(root, 'public'), output = join(root, 'dist');
const source = name => join(input, name), dest = name => join(output, name);
const bytes = Buffer.alloc(256 * 1024, 79), normalCopy = fs.copyFileSync;
let hook;
const unchanged = name => assert.deepEqual(fs.readFileSync(source(name)), bytes);
const clean = () => assert(!fs.readdirSync(output).some(n => n.startsWith('.aios-asset-copy-')), 'no temporary copy stages remain');
function asset(name) { fs.writeFileSync(source(name), bytes, { mode: 0o640 }); return name; }
try {
  fs.mkdirSync(input, { recursive: true }); fs.mkdirSync(output);
  if (process.platform !== 'darwin') {
    assert.equal(buildCopyEnvironment(root, {}).NODE_OPTIONS, undefined);
    console.log('build_asset_copy.test: non-macOS environment unchanged');
  } else {
    hook = installBuildAssetCopies(root);
    asset('中文 image.bin'); namedSync(source('中文 image.bin'), dest('中文 image.bin'));
    assert.equal(hook.stats.nativeCopies, 1);
    assert.equal(fs.statSync(dest('中文 image.bin')).mode & 0o777, 0o640);
    assert.notEqual(fs.statSync(source('中文 image.bin')).ino, fs.statSync(dest('中文 image.bin')).ino);
    fs.writeFileSync(dest('中文 image.bin'), 'independent output'); unchanged('中文 image.bin');
    // Existing destinations keep their inode/permissions and ordinary overwrite behavior.
    const inode = fs.statSync(dest('中文 image.bin')).ino;
    namedSync(source('中文 image.bin'), dest('中文 image.bin'));
    assert.equal(fs.statSync(dest('中文 image.bin')).ino, inode);
    assert.equal(hook.stats.nativeCopies, 1);
    assert.throws(() => namedSync(source('中文 image.bin'), dest('中文 image.bin'), fs.constants.COPYFILE_EXCL), { code: 'EEXIST' });
    fs.writeFileSync(source('中文 image.bin'), 'independent source'); assert.deepEqual(fs.readFileSync(dest('中文 image.bin')), bytes);
    asset('promise.bin'); await namedPromise(pathToFileURL(source('promise.bin')), pathToFileURL(dest('promise.bin')));
    asset('callback.bin'); await promisify(fs.copyFile)(source('callback.bin'), dest('callback.bin'));
    assert.equal(hook.stats.nativeCopies, 3); clean();

    asset('target.bin'); fs.symlinkSync(source('target.bin'), dest('target.bin'));
    namedSync(source('promise.bin'), dest('target.bin'));
    assert(fs.lstatSync(dest('target.bin')).isSymbolicLink());
    fs.symlinkSync(source('promise.bin'), source('link.bin'));
    namedSync(source('link.bin'), dest('link.bin'));
    fs.writeFileSync(source('small.txt'), 'small'); namedSync(source('small.txt'), dest('small.txt'));
    assert.equal(hook.stats.nativeCopies, 3, 'small files and source/destination links keep native behavior');
    const external = join(fixture, 'external'); fs.mkdirSync(external);
    fs.writeFileSync(join(external, 'outside.bin'), bytes);
    fs.symlinkSync(external, join(input, 'escape')); fs.mkdirSync(join(output, 'escape'));
    namedSync(join(input, 'escape/outside.bin'), join(output, 'escape/outside.bin'));
    fs.mkdirSync(join(input, 'escaped-output')); fs.writeFileSync(join(input, 'escaped-output/new.bin'), bytes);
    fs.symlinkSync(external, join(output, 'escaped-output'));
    namedSync(join(input, 'escaped-output/new.bin'), join(output, 'escaped-output/new.bin'));
    assert.equal(hook.stats.nativeCopies, 3, 'do not optimize through an external symlink ancestor');
    asset('wrong-name.bin'); namedSync(source('wrong-name.bin'), dest('not-the-same-name.bin'));
    assert.equal(hook.stats.nativeCopies, 3, 'only matching public/output asset paths');
    assert.throws(() => fs.copyFile(source('small.txt'), dest('small.txt')), { code: 'ERR_INVALID_ARG_TYPE' });
    assert.throws(() => namedSync(source('small.txt'), dest('small.txt'), 'invalid'), { code: 'ERR_INVALID_ARG_TYPE' });
    hook.restore();
    hook = installBuildAssetCopies(root, { localDevice: -1 });
    fs.unlinkSync(dest('small.txt')); namedSync(source('small.txt'), dest('small.txt'));
    assert.equal(hook.stats.nativeCopies, 1, 'different-volume small assets must not retain slow byte-copy path');
    assert.equal(fs.readFileSync(dest('small.txt'), 'utf8'), 'small'); clean(); hook.restore();

    // Native failure/partial copy and even an incorrect source hardlink cannot
    // publish incomplete/shared output. The original API remains the fallback.
    for (const [kind, nativeSync] of [
      ['failure', () => { throw Error('unsupported clone'); }],
      ['partial', (_cmd, args) => fs.writeFileSync(args.at(-1), 'partial')],
      ['hardlink', (_cmd, args) => fs.linkSync(args[1], args.at(-1))],
    ]) {
      hook = installBuildAssetCopies(root, { nativeSync });
      asset(kind + '.bin'); namedSync(source(kind + '.bin'), dest(kind + '.bin'));
      assert.deepEqual(fs.readFileSync(dest(kind + '.bin')), bytes);
      assert.notEqual(fs.statSync(source(kind + '.bin')).ino, fs.statSync(dest(kind + '.bin')).ino);
      assert.equal(hook.stats.fallbacks, 1); clean(); hook.restore();
    }
    // A racing destination may not be replaced by the native staging step.
    hook = installBuildAssetCopies(root, { nativeSync: (_cmd, args) => {
      normalCopy(args[1], args.at(-1)); fs.writeFileSync(dest('race.bin'), 'another writer');
    } });
    asset('race.bin'); assert.throws(() => namedSync(source('race.bin'), dest('race.bin'), fs.constants.COPYFILE_EXCL), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(dest('race.bin'), 'utf8'), 'another writer'); clean(); hook.restore();

    let active = 0, peak = 0;
    hook = installBuildAssetCopies(root, { nativeAsync: async (_cmd, args) => {
      active++; peak = Math.max(peak, active);
      await new Promise(ok => setTimeout(ok, 10)); normalCopy(args[1], args.at(-1)); active--;
    } });
    for (let i = 0; i < 12; i++) asset(`parallel-${i}.bin`);
    await Promise.all(Array.from({ length: 12 }, (_, i) => namedPromise(source(`parallel-${i}.bin`), dest(`parallel-${i}.bin`))));
    assert.equal(peak, 4); assert.equal(hook.stats.nativeCopies, 12); clean(); hook.restore();
    hook = installBuildAssetCopies(root, { nativeAsync: async () => { throw Error('unsupported'); } });
    asset('async-fallback.bin'); await namedPromise(source('async-fallback.bin'), dest('async-fallback.bin'));
    assert.deepEqual(fs.readFileSync(dest('async-fallback.bin')), bytes); assert.equal(hook.stats.fallbacks, 1); clean(); hook.restore();

    const baseEnv = { ...process.env, NODE_OPTIONS: '--no-warnings', AIOS_BUILD_COPY_ROOT: undefined };
    delete baseEnv.AIOS_BUILD_JOB_ID;
    const env = buildCopyEnvironment(root, baseEnv);
    assert(env.NODE_OPTIONS.startsWith('--no-warnings '));
    assert.equal(buildCopyEnvironment(root, env).NODE_OPTIONS, env.NODE_OPTIONS, 'no duplicate preload');
    assert.equal(baseEnv.NODE_OPTIONS, '--no-warnings', 'caller environment never mutated');
    assert.equal(buildCopyEnvironment(root, { AIOS_BUILD_FAST_COPY: '0' }).NODE_OPTIONS, undefined);
    assert.equal(buildCopyEnvironment('/Users/example/proxy', {}).NODE_OPTIONS, undefined);
    asset('child.bin');
    const child = `import fs from 'node:fs';import {buildAssetCopyStats} from ${JSON.stringify(new URL('../src/build_asset_copy.js', import.meta.url).href)};
fs.copyFileSync('public/child.bin','dist/child.bin');console.log(JSON.stringify(buildAssetCopyStats()));`;
    const result = await exec(process.execPath, ['--input-type=module', '-e', child], { cwd: root, env });
    assert.equal(JSON.parse(result.stdout).nativeCopies, 1, 'actual Node preload reaches the copy implementation'); clean();
    // The exact package build adapter used by already-running sessions.
    fs.unlinkSync(dest('child.bin'));
    const viaAdapter = await exec(process.execPath, [join(repo, 'bin/build-command.mjs'), process.execPath, '--input-type=module', '-e', child], { cwd: root, env: baseEnv });
    assert.equal(JSON.parse(viaAdapter.stdout).nativeCopies, 1); clean();
    await assert.rejects(exec(process.execPath, [join(repo, 'bin/build-command.mjs'), join(fixture, 'missing')], { env: baseEnv }), e => e.code === 127);
    await assert.rejects(exec(process.execPath, [join(repo, 'bin/build-command.mjs'), process.execPath, '-e', 'process.exit(7)'], { env: baseEnv }), e => e.code === 7);
    const fakeBin = join(fixture, 'bin'); fs.mkdirSync(fakeBin);
    fs.writeFileSync(join(fakeBin, 'npm'), `#!/usr/bin/env node\n${child}`, { mode: 0o755 });
    fs.unlinkSync(dest('child.bin'));
    const guardEnv = { ...baseEnv, PATH: fakeBin + ':' + baseEnv.PATH, AIOS_GUARDED_COMMAND: 'npm', AIOS_SESSION_ID: 's_build_copy_fixture', AIOS_NO_DEPLOY: '1' };
    const throughGuard = await exec(join(repo, 'scripts/aios-command-guard.sh'), ['run', 'build'], { cwd: root, env: guardEnv });
    assert.equal(JSON.parse(throughGuard.stdout).nativeCopies, 1, 'existing-session package wrapper activates the real preload'); clean();
    const dev = await exec(join(repo, 'scripts/aios-command-guard.sh'), ['run', 'dev'], { cwd: root, env: guardEnv });
    assert.equal(JSON.parse(dev.stdout), null, 'dev commands remain unmodified');
    const optOut = await exec(join(repo, 'scripts/aios-command-guard.sh'), ['run', 'build'], { cwd: root, env: { ...guardEnv, AIOS_BUILD_FAST_COPY: '0' } });
    assert.equal(JSON.parse(optOut.stdout), null, 'explicit opt-out remains native');
    // No root means no patch in a normal Node/service process.
    const inert = execFileSync(process.execPath, ['--input-type=module', '-e', `import {buildAssetCopyStats} from ${JSON.stringify(new URL('../src/build_asset_copy.js', import.meta.url).href)};console.log(buildAssetCopyStats());`], { env: baseEnv, encoding: 'utf8' });
    assert.equal(inert.trim(), 'null');
    console.log('build_asset_copy.test ok: real native copies, independent writes, metadata, three APIs, scope, races, fallback, bounded concurrency, preload and adapter');
  }
} finally { hook?.restore(); await fsp.rm(fixture, { recursive: true, force: true }); }
