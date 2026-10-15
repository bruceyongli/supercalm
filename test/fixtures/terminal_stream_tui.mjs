// An isolated agent surrogate: emits real PTY frames, never invokes a model.
let frame = 0;
setInterval(() => {
  process.stdout.write(`\x1b[2J\x1b[HSTREAM_FRAME_${++frame}\r\n✢ Working… (esc to interrupt)\r\n❯\r\n  bypass permissions on\r\n`);
}, 120);
