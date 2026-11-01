import assert from 'node:assert/strict';
import { confirmTerminalChoice } from '../src/terminal_confirm.js';

const menu = selected => `Quick safety check: Is this a project you created or one you trust?\n${selected===0?'❯':' '} No, exit\n${selected===1?'❯':' '} Yes, I trust this folder\nEnter to confirm · Esc to cancel\n`;
for (const loseFirstDown of [false,true]) {
  let selected=0, dropped=false; const sent=[];
  const result=await confirmTerminalChoice({screen:menu(0),keys:['down','enter'],readScreen:async()=>menu(selected),pause:async()=>{},
    sendKey:async key=>{sent.push(key);if(key==='enter')assert.equal(selected,1,'Enter never reaches default No');
      else if(loseFirstDown&&!dropped)dropped=true;else selected=1;}});
  assert.equal(result,true);assert.deepEqual(sent,loseFirstDown?['down','down','enter']:['down','enter']);
}
let sent=[];
assert.equal(await confirmTerminalChoice({screen:menu(0),keys:['down','enter'],readScreen:async()=>menu(0),pause:async()=>{},sendKey:async key=>sent.push(key)}),false);
assert.ok(!sent.includes('enter'),'lost arrows never select the negative option');
sent=[];
assert.equal(await confirmTerminalChoice({screen:menu(0),keys:['down','enter'],readScreen:async()=>menu(0)+'❯ a report\n⏵⏵ bypass permissions on',pause:async()=>{},sendKey:async key=>sent.push(key)}),false);
assert.deepEqual(sent,[],'a replaced/quoted gate receives no keys');
assert.equal(await confirmTerminalChoice({screen:menu(0),keys:['down','enter'],readScreen:async()=>menu(0),isCurrent:()=>false,pause:async()=>{},sendKey:async key=>sent.push(key)}),false);
assert.deepEqual(sent,[],'operator Stop or generation replacement cancels confirmation');
console.log('terminal_confirm: read-back selection, dropped navigation, quote and Stop fences passed');
