// First-use preferences for an operator-provisioned, dedicated native CLI home.
// Never touch the user's global CLI config or grant project/command permissions.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function initializeExecutionNative(root) {
  // Codex requires CODEX_HOME to exist even when every provider option is on argv.
  await mkdir(join(root, 'native/codex'), { recursive: true, mode: 0o700 });
  const directory = join(root, 'native/claude');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(join(directory, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true, theme: 'dark',
    }) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
}
