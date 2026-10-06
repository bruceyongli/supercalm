// An isolated fake Claude TUI. Its view changes continuously without any conversation activity.
let n = 0;
const render = () => {
  const chrome = ['Auto-updating…', 'Update available', 'Remote Control connected', ''][n++ % 4];
  const body = n % 2 ? '⏺ The docs endpoint is ready.' : '⏺ /docs/ serves the completed project documents.';
  process.stdout.write(`\x1b[2J\x1b[H${body}\n\n✻ Cogitated for 1m 39s · done 11:13 PM\n────────────────────────────────────\n❯ commit this\n────────────────────────────────────\n⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents\n${chrome}\n`);
};
render();
setInterval(render, 350);
process.stdin.resume();
