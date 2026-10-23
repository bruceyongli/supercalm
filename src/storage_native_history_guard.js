// An explicit maintenance-only exception for one idle coding client whose shared
// native history must move. It never permits a fleet/service process or project
// storage to be moved, and is not a general bypass for protected projects.
import { basename } from 'node:path';

export function assertNativeHistorySession(session, explicitNative, protectedRoot) {
  if (!session || session.project_path !== protectedRoot || session.tool !== 'codex'
      || session.status !== 'waiting' || session.desired_status !== 'waiting'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(explicitNative || '')
      || session.codex_uuid !== explicitNative) {
    throw Error('Native-history maintenance requires one explicitly selected idle coding session with its exact recorded conversation');
  }
}

export function parseNativeListeners(output) {
  let pid; const listeners=[];
  for(const line of output.trim().split('\n').filter(Boolean)) {
    if(line.startsWith('p'))pid=Number(line.slice(1));
    else if(line.startsWith('n')) {
      const m=line.slice(1).match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
      if(!Number.isInteger(pid)||pid<=0||!m)throw Error('Cannot identify protected client listener');
      listeners.push({pid,address:m[1].replace(/^\[|\]$/g,''),port:Number(m[2])});
    }
  }
  return listeners;
}

export function assertNativeHistoryProcesses({ roots, family, commands, uid, uuid, openFiles = null, listeners = [] }) {
  if (roots.length !== 1 || family.length < 1 || family.length > 4) throw Error('Protected coding client has additional processes; no fleet/service may be paused');
  const root = family.find(p => p.pid === roots[0]);
  const name = p => basename(commands.get(p?.pid)?.executable || '').replace(/^-/, '');
  if (!root || family.some(p => commands.get(p.pid)?.uid !== uid)) throw Error('Protected process identity is not owned by this operator');
  const agents = family.filter(p => name(p) === 'codex');
  if (agents.length !== 1) throw Error('Protected process is not an isolated coding client');
  const agent = agents[0];
  const core = family.filter(p => p.pid === root.pid || p.pid === agent.pid);
  if (core.length === 1 ? agent !== root
      : !['zsh', 'bash', 'sh', 'fish'].includes(name(root)) || agent.parent !== root.pid) {
    throw Error('Protected process family is not just its terminal shell and coding client');
  }
  // This CLI may own an idle stdio DevTools client. Accept only its exact isolated
  // npm -> MCP chain, never a browser or arbitrary tool task. Codex itself has
  // a loopback ephemeral control socket; this is not a shared proxy listener.
  const helpers = family.filter(p => !core.includes(p));
  const npm = helpers.filter(p => /^npm exec chrome-devtools-mcp@(?:latest|[\d.]+) --isolated(?: --no-usage-statistics)?(?: --no-performance-crux)?$/.test(name(p)));
  const mcp = helpers.filter(p => name(p) === 'chrome-devtools-mcp');
  if (npm.length > 1 || mcp.length > 1 || npm.length + mcp.length !== helpers.length
      || npm.some(p => p.parent !== agent.pid)
      || mcp.some(p => p.parent !== (npm[0]?.pid || agent.pid))
      || listeners.some(p => p.pid !== agent.pid || !['127.0.0.1','::1'].includes(p.address)
        || !Number.isInteger(p.port) || p.port < 49152 || p.port > 65535)) {
    throw Error('Protected coding client has a task/service process; no fleet/service may be paused');
  }
  if (openFiles) {
    const identities = [...new Set(openFiles.filter(f => f.pid === agent.pid)
      .map(f => f.path.match(/-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/)?.[1]).filter(Boolean))];
    if (identities.length !== 1 || identities[0] !== uuid) throw Error('Protected coding client does not own the explicitly approved conversation');
  }
  return agent.pid;
}
