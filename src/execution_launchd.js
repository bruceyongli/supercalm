// launchd bootout acknowledges before the old registration finishes retiring.
// Retry only bootstrap's transient EIO, within a short bound. Other errors remain
// visible; this never targets coding-agent tmux panes or unrelated launch agents.
export async function bootstrapExecutionService(run, domain, plist, { wait = ms => new Promise(r => setTimeout(r, ms)), attempts = 20 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { await run('/bin/launchctl', ['bootstrap', domain, plist]); return; }
    catch (error) {
      if (error.code !== 5 || attempt + 1 >= attempts) throw error;
      await wait(500);
    }
  }
}
