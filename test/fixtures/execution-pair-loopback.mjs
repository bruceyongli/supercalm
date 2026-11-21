// The real controller and registry run normally. Substitute ONLY the SSH
// transport with an authenticated loopback fixture. Never contact a real Mac.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import http from 'node:http';
// Stand in for the controller's Darwin socket ownership and its already verified
// SSH host pins. No tests write to real known_hosts or start the release tool.
let socket;
const emit=http.Server.prototype.emit;
http.Server.prototype.emit=function(event,...args){if(event==='request' && args[0]?.url?.endsWith('/devices/setup'))socket=args[0].socket;return emit.call(this,event,...args);};
const promised=promisify(cp.execFile), originalExec=cp.execFile;
const wrapped=(...args)=>originalExec(...args);
wrapped[promisify.custom]=function(file,args,...opts){
  const answer=stdout=>Promise.resolve({stdout,stderr:''});
  if(file==='/usr/sbin/netstat' && socket)return answer('tcp4 0 0 127.0.0.1.'+socket.remotePort+' 127.0.0.1.'+socket.localPort+' ESTABLISHED 0 0 0 0 browser:7878');
  if(file==='/bin/ps' && args[1]==='7878')return answer(process.getuid()+' /Applications/Safari.app/Contents/MacOS/Safari');
  if(file==='/usr/bin/ssh' && args[0]==='-G' && ['pair-fixture.invalid','linux-fixture.invalid'].includes(args.at(-1)))return answer('hostname '+args.at(-1)+'\nport 22\nuserknownhostsfile /fixture/known_hosts');
  if(file==='/usr/bin/ssh')throw Error('Fixture forbids external SSH');
  if(file==='/usr/bin/ssh-keygen' && args.at(-1)==='/fixture/known_hosts')return answer('known');
  return promised(file,args,...opts);
};
cp.execFile=wrapped;
const spawn = cp.spawn;
cp.spawn = function(file, args, ...rest) {
  if(file.endsWith('/bin/deploy')){
    const [mode,id,host]=args;
    if(mode!=='--pair-device'||!['pair-fixture.invalid','linux-fixture.invalid'].includes(host))throw Error('Unexpected fixture install');
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    setTimeout(async()=>{
      try{
        if(host==='linux-fixture.invalid'){child.stderr.end('AIOS_PAIR_ERROR linux-host\n');child.emit('close',1);return;}
        const {preparePairing}=await import('../../src/execution_pairing.js'),{COMMIT_SHA}=await import('../../src/config.js');
        const proof=await preparePairing({id,host,commit:COMMIT_SHA},async()=>join(process.env.AIOS_DATA,'worker'));
        child.stdout.end('Verified\n'+proof+'\n');child.emit('close',0);
      }catch{child.emit('close',1);}
    },650);return child;
  }
  if (file !== '/usr/bin/ssh') return spawn.call(this, file, args, ...rest);
  if (!args.includes('-N') || args.at(-1) !== 'pair-fixture.invalid') throw Error('Fixture forbids external SSH');
  const node = JSON.parse(readFileSync(process.env.AIOS_EXECUTION_NODES_FILE)).nodes.find(n => n.host === args.at(-1));
  const server = http.createServer((req,res) => {
    if (req.headers['x-aios-node-token'] !== node.token || !req.url.startsWith('/api/execution/state')) {res.writeHead(403);return res.end();}
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({protocol:1,node:node.id,cursor:0,health:{version:'fixture',disk:{available_bytes:1024**3}}}));
  });
  server.listen(node.localPort,'127.0.0.1'); const child = new EventEmitter();
  child.kill = () => server.close(); return child;
};
syncBuiltinESMExports();
