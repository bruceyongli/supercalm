// The reverse worker callback also reaches the controller's loopback port. An
// Origin or Tailscale-User-Login header alone is therefore NOT an operator grant.
// Verify the TCP peer on the Mac, only on an explicit setup request (never polling).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { migrationError } from './execution_identity.js';
import { tailnetSessionBase } from './session_link_base.js';
const exec=promisify(execFile);
const denied=()=>migrationError('Open Settings in a browser on the controller or through its private Tailscale URL using the operator account.', 'pairing-operator-required',403);
const loop = addr => ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(addr);
const local = h => ['127.0.0.1','[::1]','localhost'].includes(h);
export function peerPid(table,socket) {
  const endpoint=(addr,port)=>addr.replace(/^::ffff:/,'')+'.'+port;
  for(const line of table.split('\n')){
    const f=line.trim().split(/\s+/);
    if(f[3]!==endpoint(socket.remoteAddress,socket.remotePort) || f[4]!==endpoint(socket.localAddress,socket.localPort) || f[5]!=='ESTABLISHED')continue;
    const pid=/:(\d+)$/.exec(f[10]||'')?.[1]; if(pid && +pid>1)return pid;
  }
  throw denied();
}
async function clientProcess(socket) {
  const {stdout}=await exec('/usr/sbin/netstat',['-anv','-p','tcp'],{timeout:3500,maxBuffer:8*1024*1024});
  const pid=peerPid(stdout,socket);
  const ps=(await exec('/bin/ps',['-p',pid,'-o','uid=,comm='],{timeout:1500})).stdout.trim().match(/^(\d+)\s+(.+)$/);
  if(!ps)throw denied();
  return {uid:+ps[1],exe:ps[2]};
}
async function networkIdentity() {
  const bin=['/opt/homebrew/bin/tailscale','/usr/local/bin/tailscale','/Applications/Tailscale.app/Contents/MacOS/Tailscale'].find(existsSync);
  if(!bin)throw denied();
  const read=args=>exec(bin,args,{timeout:3000,maxBuffer:2048*1024}).then(r=>JSON.parse(r.stdout));
  const [state,serve]=await Promise.all([read(['status','--json']),read(['serve','status','--json'])]);
  return {state,serve};
}
export async function authorizeDeviceSetup(req,{peer=clientProcess,network=networkIdentity,uid=process.getuid(),operator=process.env.AIOS_PAIRING_OPERATOR_LOGIN}={}) {
  const h=req.headers,s=req.socket;
  if(h['x-aios-node-token'] || h['tailscale-funnel-request'] || h['x-aios-pairing']!=='1' || (h['sec-fetch-site'] && h['sec-fetch-site']!=='same-origin')
      || !/^application\/json(?:\s*;|$)/i.test(h['content-type']||'') || !loop(s.remoteAddress)|| !loop(s.localAddress))throw denied();
  try {
    const origin=new URL(h.origin); if(origin.origin!==h.origin)throw denied();
    const localBrowser=origin.protocol==='http:' && local(origin.hostname) && +origin.port===s.localPort && h.host===origin.host;
    if(!localBrowser && (origin.protocol!=='https:' || !origin.hostname.endsWith('.ts.net') || origin.port))throw denied();
    const p=await peer(s);
    if(localBrowser){
      // Do not turn a worker's ssh -R, an arbitrary local HTTP proxy, or a
      // forged Serve header into browser authorization.
      if(p.uid===uid && /^\/(?:Applications|System\/Library|Library\/Apple)\//.test(p.exe) &&
        /\/(?:Safari|com\.apple\.WebKit\.Networking|Google Chrome(?: Helper(?: \([^)]*\))?)?|Brave Browser(?: Helper(?: \([^)]*\))?)?|firefox|Firefox|Microsoft Edge(?: Helper(?: \([^)]*\))?)?)$/.test(p.exe))return;
      throw denied();
    }
    if(p.uid!==0 || !/^\/(?:usr\/local\/bin|opt\/homebrew\/bin|opt\/homebrew\/Cellar\/tailscale\/[^/]+\/bin)\/tailscaled$/.test(p.exe))throw denied();
    const {state,serve}=await network(), key=origin.hostname+':443';
    if(h['x-forwarded-proto']!=='https' || ![origin.host,key].includes(String(h['x-forwarded-host']||'').toLowerCase()) ||
      serve.AllowFunnel?.[key] || tailnetSessionBase({Web:{[key]:serve.Web?.[key]||{}}},s.localPort)!==origin.origin+'/aios/')throw denied();
    const clean=s=>typeof s==='string'?s.trim().toLowerCase():'';
    const login=clean(h['tailscale-user-login']);
    const owner=clean(operator || (!state.Self?.Tags?.length && state.User?.[state.Self?.UserID]?.LoginName) ||
      (Object.values(state.User||{}).some(u=>clean(u.LoginName)===clean(state.CurrentTailnet?.Name)) && state.CurrentTailnet?.Name));
    if(login && owner.includes('@') && login===owner)return;
    // Tagged machines have no user login. Trust only the controller itself,
    // using the client IP set by the verified, private Serve instance.
    const ip=String(h['x-forwarded-for']||'').trim();
    if(!login && isIP(ip) && state.Self?.TailscaleIPs?.includes(ip))return;
  } catch { /* do not expose identities, socket tables or local paths */ }
  throw denied();
}
