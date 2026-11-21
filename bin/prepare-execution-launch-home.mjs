#!/usr/bin/env node
// On the executing Mac: prepare an immutable initial seed, not a new session
// and not a change to a project's release authority or any existing checkout.
import { lstat, mkdir, mkdtemp, realpath, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { executionGit as git, assertSelfContainedCommit } from '../src/execution_git.js';
import { commitId, homePath, inspectLaunchHome, workerRoot } from '../src/execution_launch_home.js';

const [id, sourceArg, selected, option] = process.argv.slice(2);
if (!sourceArg || !commitId(selected) || option && option !== '--try-origin') throw Error('Usage: node bin/prepare-execution-launch-home.mjs PROJECT_ID SOURCE_CHECKOUT EXACT_COMMIT [--try-origin]');
const target = homePath(id), parent = dirname(target), source = await realpath(sourceArg);
const actual = (await git(source,['rev-parse','--verify','HEAD^{commit}'])).trim();
if (selected !== actual) throw Error('Source HEAD changed; select the intended committed revision explicitly');
const branch = (await git(source,['symbolic-ref','--short','-q','HEAD']).catch(e => { if (e.exitCode === 1) return 'main'; throw e; })).trim();
const origin = (await git(source,['config','--get','remote.origin.url']).catch(e => { if (e.exitCode === 1) return ''; throw e; })).trim();
const safeOrigin = /^(?:[\w.-]+@)?[\w.-]+:[\w~./-]+$|^https:\/\/[\w.-]+(?::\d+)?\/[\w./-]+$|^ssh:\/\/(?:[\w.-]+@)?[\w.-]+(?::\d+)?\/[\w./-]+$/.test(origin);
const root = await realpath(workerRoot()), local = (await lstat(homedir())).dev;
if (root !== workerRoot() || (await lstat(root)).dev !== local) throw Error('Worker root is not on its local disk');
await mkdir(parent,{recursive:true,mode:0o700});
if (await realpath(parent) !== parent || (await lstat(parent)).dev !== local) throw Error('Invalid local projects directory');
const existing = await lstat(target).then(() => true, e => { if (e.code !== 'ENOENT') throw e; return false; });
if (existing) {
  const home = await inspectLaunchHome(id);
  if (home.head !== selected) throw Error('Existing launch home has a different HEAD; it was not changed');
  console.log(JSON.stringify(home));
} else {
  const capacity = await statfs(parent);
  if (capacity.bavail * capacity.bsize < 10 * 1024 ** 3) throw Error('Not enough disk reserve to seed a project');
  const temp = await mkdtemp(join(parent,'.seed-' + id + '-'));
  try {
    await git(temp,['init','--bare','--initial-branch='+branch,'.']);
    // An origin is an optional object source, NEVER the authority for the selected commit.
    const fetch = (url, protocol) => git(temp,['-c','protocol.allow=never',...protocol.flatMap(p=>['-c','protocol.'+p+'.allow=always']),
      '-c','core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8','-c','gc.auto=0',
      'fetch','--no-tags','--no-recurse-submodules','--no-write-fetch-head','--',url,selected+':refs/heads/'+branch],
      {timeout:30*60_000,capacityDir:parent,label:'project seed'});
    let fromOrigin = false;
    if (option && safeOrigin) {
      try { await fetch(origin,['ssh','https']); fromOrigin = true; }
      catch (error) { if (error.code !== 'execution-git-failed') throw error; }
    }
    if (!fromOrigin) await fetch(source,['file']);
    if ((await git(temp,['rev-parse','HEAD^{commit}'])).trim() !== selected) throw Error('Seed commit mismatch');
    // A single-branch seed must not silently omit committed submodule workspaces.
    await assertSelfContainedCommit(temp,selected);
    if (safeOrigin) await git(temp,['remote','add','origin',origin]);
    for (const key of ['name','email']) {
      const value = (await git(source,['config','--get','user.'+key]).catch(e=>{if(e.exitCode===1)return '';throw e;})).trim();
      if (value && value.length<=512 && !/[\r\n\0]/.test(value)) await git(temp,['config','--local','user.'+key,value]);
    }
    await writeFile(join(temp,'supercalm-project'),id+'\n',{flag:'wx',mode:0o600});
    await rename(temp,target); // Never overwrite a populated repository in a concurrent seed.
    console.log(JSON.stringify({...await inspectLaunchHome(id),seed:fromOrigin?'origin-exact-commit':'source-exact-commit'}));
  } finally { await rm(temp,{recursive:true,force:true}); } // only this invocation's scratch, never the source
}
