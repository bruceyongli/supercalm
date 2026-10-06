// Tool-local compatibility, separate from shared provider/boot configuration. Never rewrite Codex or
// another tool's arguments; preserve the unwrapped native binary and every unrelated option.
export function adaptClaudeLaunch(argv, { autonomy, resume, resumeId, refreshSystemPrompt } = {}) {
  if (argv[0] !== 'claude') return argv;
  const args = [...argv];
  if (resume && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(resumeId || '')) && args[1] === '--continue') {
    args.splice(1, 1, '--resume', resumeId);
  }
  // The old `default` name remains a supported alias for manual on new versions, and also works on
  // older builds. Explicitly preserve AIOS ask when the CLI's own default is now auto.
  if (autonomy === 'ask' && !args.includes('--permission-mode') && !args.includes('--dangerously-skip-permissions')) {
    args.splice(1, 0, '--permission-mode', 'default');
  }
  // Capability-checked by the caller. On resume, native snapshots otherwise ignore a rebuilt AIOS
  // project/hygiene append prompt. Fresh launches retain the normal prompt-cache default.
  if (resume && refreshSystemPrompt && args.includes('--append-system-prompt')) {
    args.splice(1, 0, '--system-prompt-snapshot', 'off');
  }
  return args;
}
