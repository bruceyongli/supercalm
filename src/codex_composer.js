// A single bracketed paste is the transport boundary, regardless of how Codex displays it.
export const codexPaste = text => `\x1b[200~${text}\x1b[201~`;
