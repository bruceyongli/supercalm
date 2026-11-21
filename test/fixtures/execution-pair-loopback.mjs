// The real controller and registry run normally. Substitute ONLY the SSH
// transport with an authenticated loopback fixture. Never contact a real Mac.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import http from 'node:http';
const spawn = cp.spawn;
cp.spawn = function(file, args, ...rest) {
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
