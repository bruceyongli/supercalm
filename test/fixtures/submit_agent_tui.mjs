// Deterministic raw-mode agent for the private-tmux delivery regression. No model/network calls.
import { appendFileSync } from 'node:fs';
const [trace, mode = 'ignore-first', family = 'codex'] = process.argv.slice(2);
let input = '';
let attempts = 0;
let last = '';
const marker = family === 'claude' ? '❯' : '›';
const hint = family === 'claude' ? '' : 'Ask Codex to do anything';
const footer = family === 'claude' ? '⏵⏵ bypass permissions on (shift+tab to cycle)' : 'GPT-6-Astra xhigh · /tmp/delivery-test';
const render = () => process.stdout.write(`\x1b[2J\x1b[${Math.max(1, (process.stdout.rows || 30) - 8)};1H${last ? `${marker} ${last}\r\n• Completed\r\n\r\n` : ''}${marker} ${input || hint}\r\n\r\n${footer}\r\n`);
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let partialTimer;
if (mode === 'partial-paste') {
  process.stdin.on('data', data => {
    if (data === '\x15') { input = ''; render(); return; }
    if (/^[\r\n]+$/.test(data)) {
      appendFileSync(trace, JSON.stringify({ event: 'enter', input }) + '\n');
      if (partialTimer) { appendFileSync(trace, JSON.stringify({ event: 'premature', input }) + '\n'); return; }
      appendFileSync(trace, JSON.stringify({ event: 'accepted', text: input }) + '\n');
      last = input; input = ''; render(); return;
    }
    const prefix = data.slice(0, Math.max(1, Math.floor(data.length / 2)));
    input += prefix; render();
    partialTimer = setTimeout(() => { input += data.slice(prefix.length); partialTimer = null; render(); }, 1000);
  });
} else {
process.stdin.on('data', data => {
  for (const char of data) {
    if (char === '\x15') { input = ''; attempts = 0; }
    else if (char === '\r' || char === '\n') {
      attempts++;
      appendFileSync(trace, JSON.stringify({ event: 'enter', attempts, input }) + '\n');
      if (mode === 'ignore-all' || (mode === 'ignore-first' && attempts === 1)) continue;
      if (input) {
        appendFileSync(trace, JSON.stringify({ event: 'accepted', text: input }) + '\n');
        last = input; input = '';
      }
    } else input += char;
  }
  render();
});
}
render();
