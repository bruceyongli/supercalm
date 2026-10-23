import assert from 'node:assert/strict';
import { assertNativeHistorySession, assertNativeHistoryProcesses, parseNativeListeners } from '../src/storage_native_history_guard.js';

const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const session = { project_path: '/fixture/proxy', tool: 'codex', status: 'waiting', desired_status: 'waiting', codex_uuid: uuid };
assert.doesNotThrow(() => assertNativeHistorySession(session, uuid, '/fixture/proxy'));
for (const patch of [{ project_path: '/fixture/proxy/subdir' }, { project_path: '/fixture/other' },
  { tool: 'claude' }, { status: 'working' }, { desired_status: 'stopped' }, { codex_uuid: null }]) {
  assert.throws(() => assertNativeHistorySession({ ...session, ...patch }, uuid, '/fixture/proxy'));
}
assert.throws(() => assertNativeHistorySession(session, null, '/fixture/proxy'));
assert.throws(() => assertNativeHistorySession(session, 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee', '/fixture/proxy'));
const shell = { pid: 100, parent: 1 }, agent = { pid: 101, parent: 100 };
const commands = new Map([[100, { uid: 501, executable: '-zsh' }], [101, { uid: 501, executable: '/bin/codex' }]]);
const files = [{ pid: 101, path: '/fixture/history/rollout-example-' + uuid + '.jsonl' }];
const inputs = { roots: [100], family: [shell, agent], commands, uid: 501, uuid, openFiles: files };
assert.equal(assertNativeHistoryProcesses(inputs), 101);
assert.equal(assertNativeHistoryProcesses({ ...inputs, roots: [101], family: [agent] }), 101);
assert.equal(assertNativeHistoryProcesses({ ...inputs, openFiles: [...files, { ...files[0] }] }), 101, 'multiple descriptors of the same conversation are not multiple conversations');
for (const patch of [{ roots: [100, 102] }, { family: [shell, agent, { pid: 102, parent: 101 }] },
  { family: [shell] }, { uid: 502 }, { openFiles: [] }, { openFiles: [{ ...files[0], pid: 999 }] },
  { openFiles: [{ ...files[0], path: files[0].path.replace(uuid, 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee') }] },
  { family: [shell, { ...agent, parent: 999 }] }]) {
  assert.throws(() => assertNativeHistoryProcesses({ ...inputs, ...patch }));
}
for (const name of ['node', 'claude', 'proxy', 'codex-server']) {
  const changed = new Map(commands); changed.set(101, { uid: 501, executable: '/bin/' + name });
  assert.throws(() => assertNativeHistoryProcesses({ ...inputs, commands: changed }));
}
const serviceRoot = new Map(commands); serviceRoot.set(100, { uid: 501, executable: '/bin/node' });
assert.throws(() => assertNativeHistoryProcesses({ ...inputs, commands: serviceRoot }));
const twoClients = new Map(commands); twoClients.set(100, { uid: 501, executable: '/bin/codex' });
assert.throws(() => assertNativeHistoryProcesses({ ...inputs, commands: twoClients }));
const localControl={pid:101,address:'127.0.0.1',port:62408};
assert.equal(assertNativeHistoryProcesses({...inputs,listeners:[localControl]}),101);
assert.equal(assertNativeHistoryProcesses({...inputs,listeners:[{...localControl,address:'::1'}]}),101);
for(const patch of [{pid:100},{address:'0.0.0.0'},{address:'*'},{port:8789},{port:49151},{port:65536},{port:NaN}]) {
  assert.throws(()=>assertNativeHistoryProcesses({...inputs,listeners:[{...localControl,...patch}]}));
}
assert.deepEqual(parseNativeListeners('p101\nn127.0.0.1:62408\nn[::1]:62409\n'),[localControl,{pid:101,address:'::1',port:62409}]);
assert.deepEqual(parseNativeListeners(''),[]);
assert.throws(()=>parseNativeListeners('n127.0.0.1:62408'));
assert.throws(()=>parseNativeListeners('p101\nnunknown'));
const npm={pid:102,parent:101},mcp={pid:103,parent:102};
const tools=new Map(commands);tools.set(102,{uid:501,executable:'npm exec chrome-devtools-mcp@latest --isolated --no-usage-statistics --no-performance-crux'});
tools.set(103,{uid:501,executable:'chrome-devtools-mcp'});
const withTools={...inputs,family:[shell,agent,npm,mcp],commands:tools};
assert.equal(assertNativeHistoryProcesses(withTools),101,'only the CLI-owned isolated stdio tool client is permitted');
assert.throws(()=>assertNativeHistoryProcesses({...withTools,listeners:[{...localControl,pid:103}]}),'no listening tool service is permitted');
assert.throws(()=>assertNativeHistoryProcesses({...withTools,family:[shell,agent,npm,{...mcp,parent:999}]}));
const unsafe=new Map(tools);unsafe.set(102,{uid:501,executable:'npm exec chrome-devtools-mcp@latest'});
assert.throws(()=>assertNativeHistoryProcesses({...withTools,commands:unsafe}),'non-isolated browser control is not included');
assert.throws(()=>assertNativeHistoryProcesses({...withTools,family:[...withTools.family,{pid:104,parent:103}]}),'a browser or other child is outside this exception');
console.log('native-history maintenance: exact idle conversation only; extra children, fleet/service roots, changed identities and foreign owners rejected');
