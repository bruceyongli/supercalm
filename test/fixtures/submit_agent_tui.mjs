// Deterministic raw-mode agent for the private-tmux delivery regression. No model/network calls.
import { appendFileSync } from 'node:fs';
const [trace, mode = 'ignore-first', family = 'codex', nativeFile = '', nativeId = ''] = process.argv.slice(2);
const longDraft = Array.from({ length: 33 }, (_, i) => `Old request line ${i}: 保留之前输入，不要拼进新问题。`).join('\n');
let input = mode.startsWith('claude-long') || mode === 'claude-stash-blocked' ? longDraft : '';
let stashed = '';
let attempts = 0;
let last = '';
const marker = family === 'claude' ? '❯' : '›';
const hint = family === 'claude' ? '' : 'Ask Codex to do anything';
const footer = family === 'claude' ? '⏵⏵ bypass permissions on (shift+tab to cycle)' : 'GPT-6-Astra xhigh · /tmp/delivery-test';
const render = (display = input) => process.stdout.write(mode === 'question'
  ? '\x1b[2J\x1b[1;1HChoose a recovery path:\r\n❯ 1. Resume from summary\r\n  2. Resume full session as-is\r\nEnter to confirm\r\n'
  : `\x1b[2J\x1b[${Math.max(1, (process.stdout.rows || 30) - 12)};1H${last ? `${marker} ${last}\r\n• Completed\r\n\r\n` : ''}${marker} ${display || hint}\r\n\r\n${footer}\r\n`);
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let partialTimer;
if (mode === 'partial-paste' || mode === 'redraw-paste') {
  process.stdin.on('data', data => {
    if (data === '\x15') { input = ''; render(); return; }
    if (/^[\r\n]+$/.test(data)) {
      appendFileSync(trace, JSON.stringify({ event: 'enter', input }) + '\n');
      if (partialTimer) { appendFileSync(trace, JSON.stringify({ event: 'premature', input }) + '\n'); return; }
      if (mode === 'redraw-paste' && ++attempts === 1) return;
      appendFileSync(trace, JSON.stringify({ event: 'accepted', text: input }) + '\n');
      last = input; input = ''; render(); return;
    }
    if (mode === 'redraw-paste') {
      input += data;
      render(input.replace(/2\. other\.png[^\n]*/, '1. screenshot.png duplicated stale row'));
      partialTimer = setTimeout(() => { partialTimer = null; render(); }, 240);
    } else {
      const prefix = data.slice(0, Math.max(1, Math.floor(data.length / 2)));
      input += prefix; render();
      partialTimer = setTimeout(() => { input += data.slice(prefix.length); partialTimer = null; render(); }, 1000);
    }
  });
} else {
process.stdin.on('data', data => {
  for (const char of data) {
    if (char === '\x13' && family === 'claude') {
      appendFileSync(trace, JSON.stringify({ event: 'stash', text: input }) + '\n');
      if (mode === 'claude-stash-blocked') continue;
      if (input) { stashed = input; input = ''; }
      else { input = stashed; stashed = ''; }
    }
    else if (char === '\x15') {
      // Current Claude Ctrl-U is a logical-line edit, NOT a whole-buffer reset.
      if (family === 'claude') input = input.slice(0, Math.max(0, input.lastIndexOf('\n')));
      else input = '';
      attempts = 0;
    }
    else if (char === '\r' || char === '\n') {
      attempts++;
      appendFileSync(trace, JSON.stringify({ event: 'enter', attempts, input }) + '\n');
      if (mode === 'ignore-all' || mode === 'claude-long-fail' || (mode === 'ignore-first' && attempts === 1)) continue;
      if (input) {
        appendFileSync(trace, JSON.stringify({ event: 'accepted', text: input }) + '\n');
        if (mode === 'claude-queued' && nativeFile) {
          appendFileSync(nativeFile, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: nativeId, content: input }) + '\n');
          last = input; input = 'busy redraw, not a new operator draft';
          render(); return;
        }
        last = input; input = '';
      }
    } else input += char;
  }
  render();
});
}
appendFileSync(trace, JSON.stringify({ event: 'ready', input }) + '\n');
render();
