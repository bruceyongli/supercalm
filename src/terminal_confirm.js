import { setTimeout as sleep } from 'node:timers/promises';
import { terminalQuestionPrompt } from './detect_classify.js';

const identity = prompt => prompt && JSON.stringify([prompt.question, prompt.options.map(o=>o.label)]);

// A newly painted native menu can lose the first navigation key. Sending Enter
// blindly afterward selects the default "No, exit" and destroys a fresh launch.
// Read back the selection after navigation; never infer it from tmux's exit code.
export async function confirmTerminalChoice({ screen, keys, readScreen, sendKey, isCurrent = ()=>true, pause = sleep }) {
  const original = terminalQuestionPrompt(screen), expected = identity(original);
  const target = original?.options.findIndex(o => JSON.stringify(o.keys) === JSON.stringify(keys));
  if (target == null || target < 0) return false;
  const observe = async () => {
    if (!isCurrent()) return null;
    const prompt = terminalQuestionPrompt(await readScreen());
    return identity(prompt) === expected ? prompt : null;
  };
  await pause(300); // let the first native frame install its input handlers
  for (let attempt = 0; attempt < original.options.length + 2; attempt++) {
    const prompt = await observe();
    if (!prompt) return false;
    const selected = prompt.options.findIndex(o=>o.selected);
    if (selected < 0) return false;
    if (selected === target) {
      await pause(180);
      const stable = await observe();
      if (!stable?.options[target]?.selected || !isCurrent()) return false;
      await sendKey('enter'); return true;
    }
    if (!isCurrent()) return false;
    await sendKey(selected < target ? 'down' : 'up');
    await pause(280);
  }
  return false; // a later poll may retry the same visible gate, never blind-submit it
}
