// A launch can die at a CLI trust/auth gate before the provider creates its native conversation.
// AIOS still owns the original task in messages(source=task). In that one precise state, `--continue`
// can only answer "No conversation found"; restarting with the durable task is the true continuation.
export function originalTaskSeed(messages, { hasNativeConversation = false } = {}) {
  if (hasNativeConversation) return null;
  const incoming = (messages || []).filter((message) => message?.direction === 'in');
  if (incoming.length !== 1 || incoming[0].source !== 'task') return null;
  const text = String(incoming[0].text || '').trim();
  return text || null;
}
