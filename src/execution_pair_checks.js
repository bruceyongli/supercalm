// Fixed, non-mutating checks. Never accept a command, path, password or SSH
// option from Settings, or reflect raw remote stderr to the browser.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);
export const pairingErrors = Object.freeze({
  'linux-host':'SSH connected to Linux. Execution devices currently require an Apple Silicon Mac. Nothing was installed. For file storage, use Settings → Storage.',
  'other-platform':'SSH connected, but this is not an Apple Silicon Mac. Nothing was installed.',
  'unknown-host-key':'The controller has no verified SSH host key for that address, or its key changed. Verify the host on the controller first, then retry.',
  'ssh-auth':'The device rejected the controller’s SSH key. Check the SSH account and authorize its public key on the device.',
  'ssh-offline':'The controller could not reach that SSH address. Check the hostname, Remote Login, and network connection.',
  'mac-node':'SSH connected to the Mac, but Homebrew Node is missing at /opt/homebrew/bin/node.',
  'mac-tmux':'SSH connected to the Mac, but Homebrew tmux is missing at /opt/homebrew/bin/tmux.',
  'mac-login':'Log in to the target Mac’s desktop with the SSH account, then retry.',
  'mac-git':'Git is unavailable on the target Mac. Install its Command Line Tools, then retry.',
  'already-worker':'This Mac already has a controller or a different worker. Its installation was not changed.',
  'execution-device-exists':'This device ID or host is already registered. Existing devices were not changed.',
  'setup-release':'The controller is not running this clean, tagged release. Try again after the release finishes.',
  'setup-failed':'Device setup did not finish. Check the target’s prerequisites and retry with the same ID and SSH address.',
});
export const pairError = code => Object.assign(Error(pairingErrors[code]), {code});
export const setupSshOptions = ['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',
  '-o','UpdateHostKeys=no','-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no'];
export function sshFailure(error) {
  const s = String(error.stderr || '');
  if (/authentication failed|permission denied/i.test(s)) return pairError('ssh-auth');
  if (/host key verification|host identification has changed|no .*host key is known/i.test(s)) return pairError('unknown-host-key');
  if (error.killed || /timed out|connection refused|resolve hostname|no route to host|network is unreachable/i.test(s)) return pairError('ssh-offline');
  if (/already (?:belongs|has a worker|a controller)/i.test(s)) return pairError('already-worker');
  return pairError('setup-failed');
}
// One pinned destination, never host discovery. ssh -G resolves the operator's
// existing alias/port without making a connection. The real SSH exchange
// independently enforces StrictHostKeyChecking, including on subsequent calls.
export async function requireKnownPairHost(host, run=exec) {
  const {stdout} = await run('/usr/bin/ssh',['-G','-o','CanonicalizeHostname=no',host],{timeout:3500,maxBuffer:131072});
  const field = name => stdout.split('\n').find(s=>s.startsWith(name+' '))?.slice(name.length+1).trim();
  const hostname = field('hostname'), port = Number(field('port')), alias=field('hostkeyalias');
  if (!hostname || !Number.isInteger(port) || port<1 || port>65535) throw pairError('unknown-host-key');
  const key = alias && alias !== 'none' ? alias : port===22 ? hostname : '['+hostname+']:'+port;
  const files=(field('userknownhostsfile')||'~/.ssh/known_hosts').split(/\s+/)
    .concat((field('globalknownhostsfile')||'/etc/ssh/ssh_known_hosts').split(/\s+/));
  for (let file of files.slice(0,12)) {
    if(file.startsWith('~/')) file=join(homedir(),file.slice(2));
    if(!file.startsWith('/') || /[%\r\n\0]/.test(file))continue;
    try { await run('/usr/bin/ssh-keygen',['-F',key,'-f',file],{timeout:2000,maxBuffer:65536}); return; } catch {}
  }
  throw pairError('unknown-host-key');
}
export async function inspectPairPlatform(run) {
  const platform=(await run('',15000,'uname -sm')).trim();
  if (/^Linux(?:\s|$)/i.test(platform)) throw pairError('linux-host');
  if (platform !== 'Darwin arm64') throw pairError('other-platform');
  // Fixed portable shell, no interpolation or remote writes.
  const result=(await run('',15000,'if [ ! -x /opt/homebrew/bin/node ]; then echo node; elif [ ! -x /opt/homebrew/bin/tmux ]; then echo tmux; elif ! /usr/bin/git --version >/dev/null 2>&1; then echo git; elif ! /bin/launchctl print gui/$(/usr/bin/id -u) >/dev/null 2>&1; then echo login; else echo ready; fi')).trim();
  if(result!=='ready') throw pairError(({node:'mac-node',tmux:'mac-tmux',git:'mac-git',login:'mac-login'})[result]||'setup-failed');
}
