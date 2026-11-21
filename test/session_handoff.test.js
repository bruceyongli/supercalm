import assert from 'node:assert/strict';
import { configuredSessionBase, tailnetSessionBase } from '../src/session_link_base.js';
import { sessionHandoffUrl } from '../web/session-handoff.js';

const host = 'controller.example.ts.net', sid = 's_fixture';
assert.equal(configuredSessionBase('https://'+host),'https://'+host+'/aios/');
assert.equal(configuredSessionBase('https://'+host+'/team/aios'),'https://'+host+'/team/aios/');
for (const value of ['http://127.0.0.1:8793','file:///x','https://u:p@'+host,'https://'+host+'/?token=x'])
  assert.equal(configuredSessionBase(value),null);
const serve = target => ({Web:{[host+':443']:{Handlers:{'/':{Proxy:'http://127.0.0.1:8788'},'/aios':{Proxy:target}}}}});
assert.equal(tailnetSessionBase(serve('http://127.0.0.1:8793'),8793),'https://'+host+'/aios/');
for (const target of ['http://127.0.0.1:9999','http://other:8793','http://127.0.0.1:8793/other'])
  assert.equal(tailnetSessionBase(serve(target),8793),null);
assert.equal(sessionHandoffUrl(sid,'https://'+host+'/aios/session.html?mint=anything&from=phone#private'),'https://'+host+'/aios/session?id='+sid);
assert.equal(sessionHandoffUrl('a&b','https://'+host+'/aios/'),'https://'+host+'/aios/session?id=a%26b');
console.log('Session handoff: normalized ID-only deep link and verified controller mount passed.');
