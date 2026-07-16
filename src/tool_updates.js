// One-click CLI maintenance: "is a newer claude/codex/agy out?" + run each tool's own
// self-updater from the dashboard. Latest versions come straight from the npm registry
// (no npm binary needed — plain fetch); agy has no public registry so its row only offers
// "run updater" (the CLI's `agy update` knows its own channel). POST /api/tools/check is
// the one-click: re-check versions AND rescan the model catalog in one go.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { route, json } from './server.js';
import { TOOLS } from './config.js';
import { modelsSummary, rescanModels } from './model_scan.js';

const exec = promisify(execFile);
// launchd PATH is minimal; cover homebrew + the user-local bin where codex/agy live.
const PATH = `/opt/homebrew/bin:${homedir()}/.local/bin:/usr/local/bin:/usr/bin:/bin`;
const ENV = { ...process.env, PATH };
const CHECK_TTL_MS = 10 * 60_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;

const CLI = {
  claude: { bin: 'claude', registry: '@anthropic-ai/claude-code', update: ['claude', 'update'] },
  codex: { bin: 'codex', registry: '@openai/codex', update: ['codex', 'update'] },
  agy: { bin: 'agy', registry: null, update: ['agy', 'update'] },
};

const parseVersion = (s) => String(s || '').match(/\d+\.\d+\.\d+[A-Za-z0-9.-]*/)?.[0] || null;

async function currentVersion(id) {
  try {
    const { stdout, stderr } = await exec(CLI[id].bin, ['--version'], { env: ENV, timeout: 15_000 });
    return parseVersion(stdout) || parseVersion(stderr);
  } catch {
    return null; // not installed / not on PATH
  }
}

async function latestVersion(id) {
  const pkg = CLI[id].registry;
  if (!pkg) return null;
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return parseVersion((await res.json()).version);
  } catch {
    return null;
  }
}

let checkCache = { at: 0, tools: null };
async function checkAll({ force = false } = {}) {
  if (!force && checkCache.tools && Date.now() - checkCache.at < CHECK_TTL_MS) return checkCache;
  const tools = await Promise.all(
    Object.keys(CLI).map(async (id) => {
      const [current, latest] = await Promise.all([currentVersion(id), latestVersion(id)]);
      return {
        id,
        label: TOOLS[id]?.label || id,
        bin: CLI[id].bin,
        current,
        latest,
        // aliases: onboarding/settings/the dashboard hero were written against {installed, version} —
        // serving both shapes at the source fixes every consumer (the shape mismatch made the
        // onboarding wizard render every CLI as not-installed and wedge its step-1 gate).
        installed: !!current,
        version: current,
        updateAvailable: !!(current && latest && current !== latest),
      };
    })
  );
  checkCache = { at: Date.now(), tools };
  return checkCache;
}

async function runUpdater(argv) {
  try {
    const { stdout, stderr } = await exec(argv[0], argv.slice(1), {
      env: ENV,
      timeout: UPDATE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, output: (stdout + '\n' + stderr).trim() };
  } catch (e) {
    return { ok: false, output: ((e.stdout || '') + '\n' + (e.stderr || '') + '\n' + e.message).trim() };
  }
}

route('GET', '/api/tools/versions', async (req, res, params, url) => {
  const c = await checkAll({ force: url.searchParams.get('force') === '1' });
  json(res, 200, { ok: true, checkedAt: new Date(c.at).toISOString(), tools: c.tools, models: modelsSummary() });
});

// The one-click "scan": latest CLI versions + fresh model catalog in a single POST.
route('POST', '/api/tools/check', async (req, res) => {
  const [c, models] = await Promise.all([checkAll({ force: true }), rescanModels().catch((e) => ({ ok: false, error: e.message }))]);
  json(res, 200, { ok: true, checkedAt: new Date(c.at).toISOString(), tools: c.tools, models });
});

route('POST', '/api/tools/:id/update', async (req, res, params) => {
  const id = params.id;
  const cli = CLI[id];
  if (!cli) return json(res, 404, { error: `unknown tool ${id}` });
  const from = await currentVersion(id);
  let r = await runUpdater(cli.update);
  let to = await currentVersion(id);
  // npm-managed installs (e.g. the homebrew-global claude/codex that sessions resolve
  // first on TOOL_PATH) want npm itself to do the bump — their own updater manages a
  // different (standalone) install and leaves the npm binary stale.
  if (cli.registry && to === from) {
    const c = await checkAll({});
    const t = c.tools.find((x) => x.id === id);
    if (t?.updateAvailable) {
      const viaNpm = await runUpdater(['npm', 'install', '-g', `${cli.registry}@latest`]);
      r = { ok: r.ok || viaNpm.ok, output: (r.output + '\n--- npm fallback ---\n' + viaNpm.output).trim() };
      to = await currentVersion(id);
    }
  }
  checkCache.at = 0; // version changed (or at least attempted) -> next check is fresh
  json(res, 200, {
    ok: r.ok || (to && to !== from),
    tool: id,
    from,
    to,
    changed: !!(to && to !== from),
    output: r.output.slice(-4000),
  });
});
