import assert from 'node:assert/strict';
import { parseExecutionPane } from '../src/execution_pane.js';

const name = 'aios-elevate-claude-bd72';
assert.deepEqual(parseExecutionPane(`${name}|%8|1198|zsh|0\n`,name),{paneId:'%8',pid:1198,command:'zsh'});
assert.deepEqual(parseExecutionPane(`${name}|%123|98765|codex|0\n`,name),{paneId:'%123',pid:98765,command:'codex'},
  'the caller still must enforce its idle-shell allowlist; parsing does not bless agents');
for (const output of ['|', '', `${name}|%8|1198|zsh|0\n${name}|%9|1200|zsh|0\n`,
  `different-session|%8|1198|zsh|0\n`, `${name}|8|1198|zsh|0\n`, `${name}|%8||zsh|0\n`,
  `${name}|%8|0|zsh|0\n`, `${name}|%8|-1|zsh|0\n`, `${name}|%8|1.5|zsh|0\n`,
  `${name}|%8|9007199254740992|zsh|0\n`, `${name}|%8|1198||0\n`, `${name}|%8|1198|zsh|1\n`,
  `${name}|%8|1198|zsh|0|unexpected\n`, `${name}|%8|1198|zsh\0|0\n`]) {
  assert.throws(()=>parseExecutionPane(output,name),/identity/,JSON.stringify(output));
}
assert.throws(()=>parseExecutionPane(`${name}|%8|1198|zsh|0\n`,name+'|other'),/identity/);
console.log('execution_pane.test ok: exact single live pane, real idle-shell format, ambiguous/dead/malformed/cross-session evidence denied');
