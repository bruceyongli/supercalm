import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildDependencyRebuildPolicy, validateDependencyRebuildPolicy } from '../src/execution_dependency_policy.js';

const project = {id:'p_elevate',path:'/Users/bb1/elevate'};
const source = '/Users/bb1/.local/share/aios/worktrees/elevate/s_current';
const oldSibling = '/Users/bb1/.local/share/aios/worktrees/elevate/s_moved';
const physicalSibling = '/Volumes/Spark/projects/elevate/s_moved';
const workerSibling = '/Users/bb2/.local/share/supercalm-executor/workspaces/s_moved';
const spec = {kind:'move',project,session:{id:'s_current',project_id:project.id,worktree_path:source},sourcePath:source};
const previous = {kind:'move',project,session:{id:'s_moved',project_id:project.id,worktree_path:oldSibling},sourcePath:physicalSibling};
const operation = {kind:'move',session_id:'s_moved',detail:JSON.stringify({spec:previous})};
const sessions = [{id:'s_moved',project_id:project.id,worktree_path:workerSibling},
  {id:'s_other',project_id:'p_other',worktree_path:'/Users/bb1/other-project'},
  {id:'s_wide',project_id:project.id,worktree_path:homedir()},
  {id:'s_bad',project_id:project.id,worktree_path:'/Users/bb1/../bb1'}];
const policy = buildDependencyRebuildPolicy(spec,{project,sessions,operations:[operation]});
assert.deepEqual(policy,{version:1,allowedSourceRoots:[project.path,source,oldSibling,physicalSibling,workerSibling].sort()});
assert.ok(!policy.allowedSourceRoots.includes('/Users/bb1/.local/share/aios/worktrees/elevate'),'never collapse siblings into a shared parent');
assert.deepEqual(buildDependencyRebuildPolicy(spec,{project,sessions,operations:[operation,operation]}),policy,'records deduplicate exact roots');
assert.deepEqual(validateDependencyRebuildPolicy(policy),policy);
assert.deepEqual(buildDependencyRebuildPolicy(spec,{project,sessions,operations:[
  {kind:'move',session_id:'s_other',detail:operation.detail},
  {kind:'launch',session_id:'s_moved',detail:operation.detail},
  {kind:'move',session_id:'s_moved',detail:JSON.stringify({spec:{...previous,project:{...project,id:'p_other'}}})},
  {kind:'move',session_id:'s_moved',detail:JSON.stringify({spec:{...previous,session:{...previous.session,project_id:'p_other'}}})},
  {kind:'move',session_id:'s_moved',detail:'invalid JSON'},
]}).allowedSourceRoots,[project.path,source,workerSibling].sort(),'cross-session/project records never grant roots');
for (const root of ['/', '/Users', '/Users/bb1', '/private/tmp', homedir(), '/Users/bb1/proxy',
  '/Users/bb1/elevate/../secret', '/Users/bb1/elevate/', 'relative/project', '/Users/bb1/elevate\nsecret']) {
  assert.throws(()=>validateDependencyRebuildPolicy({version:1,allowedSourceRoots:[root]}),/Invalid/,root);
}
for (const value of [null, {version:2,allowedSourceRoots:[source]}, {version:1,allowedSourceRoots:[]},
  {version:1,allowedSourceRoots:[source,source]}, {version:1,allowedSourceRoots:[source],allowAll:true}]) {
  assert.throws(()=>validateDependencyRebuildPolicy(value),/Invalid/);
}
assert.throws(()=>buildDependencyRebuildPolicy({...spec,session:{...spec.session,project_id:'p_other'}}),/identity conflict/);
assert.throws(()=>buildDependencyRebuildPolicy(spec,{project:{...project,id:'p_other'}}),/identity conflict/);
assert.throws(()=>buildDependencyRebuildPolicy({kind:'move',project:{id:project.id,path:homedir()},session:{id:'s_home',project_id:project.id}}),/Invalid/);
assert.ok(validateDependencyRebuildPolicy({version:1,allowedSourceRoots:[join(homedir(),'specific-project')]}));
console.log('execution_dependency_policy.test ok: exact same-project current+historical roots, moved sibling recovery, no parent/home/proxy/cross-session expansion');
